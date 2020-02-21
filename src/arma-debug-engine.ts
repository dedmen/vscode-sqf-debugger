import * as net from 'net';
import { EventEmitter } from 'events';


export enum BreakpointAction
{
    ExecCode = 1,
    Halt = 2,
    LogCallstack = 3
};

export enum BreakpointCondition
{
    Code = 1,
    HitCount = 2
};

export interface IBreakpointActionExecCode {
    type: BreakpointAction.ExecCode;
    code: string;
};

export interface IBreakpointActionHalt {
    type: BreakpointAction.Halt;
};

export interface IBreakpointActionLogCallstack {
    type: BreakpointAction.LogCallstack;
    basePath: 'send' | string;
};

export interface IBreakpointConditionCode {
    type: BreakpointCondition.Code;
    code: string;
};

export interface IBreakpointConditionHitCount {
    type: BreakpointCondition.HitCount;
    count: number;
};

export interface IBreakpointRequest {
    action: IBreakpointActionExecCode | IBreakpointActionHalt | IBreakpointActionLogCallstack;
    condition: IBreakpointConditionCode | IBreakpointConditionHitCount | null;
    filename: string | null;
    line: number;
}

enum Commands {
    Hello = 1,
    AddBreakpoint = 2,
    RemoveBreakpoint = 3,
    ContinueExecution = 4,
    MonitorDump = 5,
    SetHookEnable = 6,
    GetVariable = 7,
    GetCurrentCode = 8,
    GetAllScriptCommands = 9,
    GetAvailableVariables = 10
}

export enum ContinueExecutionType {
    Continue = 0,
    StepInto = 1,
    StepOver = 2,
    StepOut = 3,
}

enum RemoteCommands {
    Invalid = 0,
    VersionInfo = 1,
    HaltBreakpoint = 2,
    HaltStep = 3,
    HaltError = 4,
    HaltScriptAssert = 5,
    HaltScriptHalt = 6,
    HaltPlaceholder = 7,
    ContinueExecution = 8,
    VariableReturn = 9,
    VariablesReturn = 10
}

enum DebuggerState {
    Uninitialized = 0,
    running = 1,
    breakState = 2,
    stepState = 3
};

export enum VariableScope {
    Stack = 1,
    Local = 2,
    MissionNamespace = 4,
    UiNamespace = 8,
    ProfileNamespace = 16,
    ParsingNamespace = 32
};

interface IRemoteMessage {
    handle?: string;
    command: RemoteCommands;
    data: any;
    callstack?: ICallStackItem[];
    instruction?: ICompiledInstruction;

    build?: number;
    version?: string;
    arch?: string;
    state?: DebuggerState;
}

interface ICompiledInstruction {
    fileOffset: { 0: number; 1: number; 2: number };
    filename: string;
    name: string;
    type: string;
}

interface IClientMessage {
    handle: string;
    command: Commands;
    data: any;
}


export interface IValue {
    type: 'string' | 'nil' | 'float' | 'array';
    value: string | number | IValue[];
}

export interface ICallStackItem {
    contentSample: string;
    fileName?: string;
    ip: string;
    lastInstruction: ICompiledInstruction,
    type: string;
    variables: {
        [key: string]: IValue
    };
    fileOffset?: {
        0: number;
        1: number;
        2: number;
    };
    compiled: ICompiledInstruction[];
}

export interface IVariable extends IValue {
    name?: string;
}

interface IVariableRequest {
    scope?: VariableScope; 
    name: string[];
}

interface IVariableListRequest {
    scope?: VariableScope;
}

export class ArmaDebugEngine extends EventEmitter {
    connected: boolean = false;
    initialized: boolean = false;

    messageQueue: IClientMessage[] = [];

    client: net.Socket | null = null;

    callStack?: ICallStackItem[];

    breakpoints: { [key: number]: IBreakpointRequest } = {};
    breakpointId = 0;

    nextRequestId = 0;

    static OOP_PREFIX = "o_";
    static MEMBER_SEPARATOR = "_";
    static OBJECT_SEPARATOR = "_N_";
    static SPECIAL_SEPARATOR = "_spm_";
    static STATIC_SEPARATOR = "_stm_";
    static METHOD_SEPARATOR = "_fnc_";
    static INNER_PREFIX = "inner_";
    static GLOBAL_SEPARATOR = "global_";

    // ==== Private special members
    static NEXT_ID_STR = "nextID";
    static MEM_LIST_STR = "memList";
    static STATIC_MEM_LIST_STR = "staticMemList";
    static SERIAL_MEM_LIST_STR = "serialMemList";
    static METHOD_LIST_STR = "methodList";
    static PARENTS_STR = "parents";
    static OOP_PARENT_STR = "oop_parent";
    static OOP_PUBLIC_STR = "oop_public";
    static NAMESPACE_STR = "namespace";

    constructor() {
        super();
    }

    connect() {
        if (this.connected) {
            throw new Error('Trying to connect when already connected.');
        }

        this.client = net.connect('\\\\.\\pipe\\ArmaDebugEnginePipeIface', () => {
            this.connected = true;
            this.sendCommand(this.nextHandle(), Commands.Hello);
        });

        this.client.on('data', (data) => {
            data.toString().split('\n').filter(str => str).forEach(str => {
                this.receiveMessage(JSON.parse(str) as IRemoteMessage);
            });
        });

        this.client.on('close', () => {
            this.connected = false;
            this.initialized = false;
            this.client = null;
            //setTimeout(() => this.connect(), 1000);
        });
        
        this.client.on('error', (err) => {
            if(err.name === 'ENOENT') {
                this.l(`Server not available, did you load ADE correctly?`);
            } else {
                this.l(`Socket error: ${JSON.stringify(err)}`);
            };
            this.connected = false;
            this.client = null;

            //setTimeout(() => this.connect(), 1000);
        });
    }

    end() {
        this.client?.destroy();
    }

    protected nextHandle():string { return (++this.nextRequestId).toString(); }

    addBreakpoint(breakpoint: IBreakpointRequest) {
        this.breakpoints[this.breakpointId++] = breakpoint;

        this.sendCommand(this.nextHandle(), Commands.AddBreakpoint, breakpoint);

        return this.breakpointId - 1;
    }

    removeBreakpoint(breakpoint: IBreakpointRequest) {
        this.sendCommand(this.nextHandle(), Commands.RemoveBreakpoint, breakpoint);
    }

    clearBreakpoints(path: string) {
        this.l(`clearing ${JSON.stringify(this.breakpoints)} breakpoints for ${path}`);
        Object.entries(this.breakpoints).forEach((value: [string, IBreakpointRequest]) => {
            this.l(`clearing breakpoints for ${path}: ${value}`);
            let breakpoint = value[1]; //this.breakpoints[index] as IBreakpointRequest;
            if (breakpoint.filename && breakpoint.filename.toLowerCase() === path.toLowerCase()) {
                this.removeBreakpoint(breakpoint);
                delete this.breakpoints[+value[0]];
            }
        });
    }

    continue(type: ContinueExecutionType = ContinueExecutionType.Continue) {
        this.sendCommand(this.nextHandle(), Commands.ContinueExecution, type);
    }


    getVariable(scope: VariableScope, name: string): Promise<IVariable | null> {
        return this.getVariables(scope, [name]).then(vars => {
            if(vars) {
                return vars[0];
            }
            return null;
        });
    }

    getVariables(scope: VariableScope, names: string[]): Promise<IVariable[] | null> {
        return new Promise((resolve, reject) => {
            let request:IVariableRequest = { 
                scope,
                name: names
            };
            let handle = this.nextHandle();
            this.once('variable'+handle, data => {
                //this.l(`getVariables ${scope}:${names} returned ${data[0].value}`);
                return resolve(data as IVariable[]);
            });
            this.sendCommand(handle, Commands.GetVariable, request);
        });
    }

    getVariablesInScope(scope: VariableScope, ): Promise<any> {
        return new Promise((resolve, reject) => {
            let request:IVariableListRequest = { 
                scope
            };
            let handle = this.nextHandle();
            this.once('variables'+handle, data => resolve(data));
            this.sendCommand(handle, Commands.GetAvailableVariables, request);
        });
    }

    getStackVariables(frame:number) {
        return (this.callStack && this.callStack.length > frame) ? 
            this.callStack.slice(0, frame+1).map(c => c.variables).reduceRight((prev, curr) => Object.assign(prev, curr), {})
            //this.callStack[frame].variables
            :
            null;
    }

    getCallStack() {
        return this.callStack;
    }

    private l(message: string) {
        this.emit('log', message);
    }

    private emitStep(type:string, message:IRemoteMessage) {
        this.callStack = message.callstack;

        if (this.callStack) {
            this.callStack.forEach(c => {
                if (c.compiled && c.compiled.length > 0) {
                    c.fileOffset = c.compiled[0].fileOffset;
                }
            });
        }

        if (message.instruction && this.callStack && !this.callStack[this.callStack.length - 1].fileOffset) {
            this.callStack[this.callStack.length - 1].fileOffset = message.instruction.fileOffset;
            this.callStack[this.callStack.length - 1].fileName = message.instruction.filename;
        }

        this.emit(type, message.callstack);
    }

    private receiveMessage(message: IRemoteMessage) {
        //this.l("Received:");
        //this.l(JSON.stringify(message));

        switch (message.command) {
            case RemoteCommands.VersionInfo:

                this.initialized = true;
                this.emit('connected', message);
                this.messageQueue.forEach(msg => this.send(msg));
                this.messageQueue = [];

                break;
            
            case RemoteCommands.HaltStep:
                this.emitStep('halt-step', message);
                break;

            case RemoteCommands.HaltBreakpoint:
                this.emitStep('halt-breakpoint', message);
                break;

            case RemoteCommands.HaltError:
                this.emitStep('halt-error', message);
                break;

            case RemoteCommands.HaltScriptAssert:
                this.emitStep('halt-assert', message);
                break;

            case RemoteCommands.HaltScriptHalt:
                this.emitStep('halt-halt', message);
                break;

            case RemoteCommands.VariableReturn:
                this.emit('variable' + (message.handle || ''), message.data);
                break;

            case RemoteCommands.VariablesReturn:
                this.emit('variables' + (message.handle || ''), message.data);
                break;
        }
    }

    private sendCommand(handle:string, command: Commands, data: any = null) {
        return this.send({
            handle,
            command,
            data
        });
    }

    private send(data: IClientMessage) {
        if (!this.connected || (data.command !== Commands.Hello && !this.initialized)) {
            this.messageQueue.push(data);
            return;
        }

        //this.l("Send:");
        //this.l(JSON.stringify(data));
        if (this.client) {
            this.client.write(JSON.stringify(data) + '\n');
        };
    }
}