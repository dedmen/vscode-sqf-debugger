import * as WebSocket from 'ws';
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
    getVersionInfo = 1,
    addBreakpoint = 2,
    delBreakpoint = 3,
    BPContinue = 4,
    MonitorDump = 5,
    SetHookEnable = 6,
    getVariable = 7,
    getCurrentCode = 8,
    getAllScriptCommands = 9,
    getAvailableVariables = 10,
    haltNow = 11, // Triggers halt on next possible instruction
    ExecuteCode = 12, // Executes code while halted, in current context and returns result
    LoadFile = 13, // load a file and return the contents
    clearAllBreakpoints = 14,
    clearFileBreakpoints = 15,
    SetExceptionFilter = 16
}

export enum ContinueExecutionType {
    Continue = 0,
    StepInto = 1,
    StepOver = 2,
    StepOut = 3,
}

enum RemoteCommands {
    Invalid = 0,
    versionInfo = 1,
    halt_breakpoint = 2,
    halt_step = 3,
    halt_error = 4,
    halt_scriptAsserts = 5,
    halt_scriptHalt = 6,
    halt_placeholder = 7,
    ContinueExecution = 8,
    VariableReturn = 9,
    VariablesReturn = 10,
    BreakpointLog = 11, // A log breakpoint was triggered
    LogMessage = 12, // A log message from the game, for example from echo script command
    ExecuteCodeResult = 13, // Result of ExecuteCode command
    LoadFileResult = 14
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

export enum ScriptErrorType {
    ok = 0,
    gen = 1,                        //Generic error in expression
    expo = 2,                       //Exponent out of range or invalid
    num = 3,                        //Invalid number in expression
    var = 4,                        //Undefined variable in expression: %s
    bad_var = 5,                    //Reserved variable in expression
    div_zero = 6,                   //Zero divisor
    tg90 = 7,                       //Tangents of 90 degrees
    openparenthesis = 8,            //Missing (
    closeparenthesis = 9,           //Missing )
    open_brackets = 10,              //Missing [
    close_brackets = 11,             //Missing ]
    open_braces = 12,                //Missing {
    close_braces = 13,               //Missing }
    equ = 14,                        //Missing =
    semicolon = 15,                  //Missing ;
    quote = 16,                      //Missing ""
    single_quote = 17,               //Missing '
    oper = 18,                       //Unknown operator %s
    line_long = 19,                  //Line is too long
    type = 20,                       //Type %s, expected %s
    name_space = 21,                 //Local variable in global space
    dim = 22,                        //%d elements provided, %d expected
    unexpected_closeb = 23,          //unexpected )
    assertion_failed = 24,           //Assertation failed
    halt_function = 25,              //Debugger breakpoint hit
    foreign = 26,                    //Foreign error: %s
    scope_name_defined_twice = 27,   //Scope name defined twice
    scope_not_found = 28,
    invalid_try_block = 29,
    unhandled_exception = 30,        //Unhandled exception: %s
    stack_overflow = 31,
    handled = 32
}

export interface IError {
    content: string;
    filename: string;
    fileOffset: { 0: number; 1: number; 2: number };
    message: string;
    type: number;
};

export interface IRemoteMessage {
    handle?: string;
    command: RemoteCommands;
    data: any;
    callstack?: ICallStackItem[];
    instruction?: ICompiledInstruction;

    build?: number;
    version?: string;
    arch?: string;
    state?: DebuggerState;
    error?: string | IError;
    halt?: IError;

    code?: string;
    fileName?: string;
    exception?: string;
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
    data?: any;
    file?: string; // for getting code
}

export interface IValue {
    type: 'string' | 'nil' | 'float' | 'array';
    value: string | number | IValue[];
}

export interface ICallStackItem {
    contentSample: string;
    fileName?: string;
    ip?: string;
    lastInstruction: ICompiledInstruction,
    type?: string;
    variables?: {
        [key: string]: IValue
    };
    fileOffset?: { 0: number; 1: number; 2: number };
    compiled?: ICompiledInstruction[];
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

interface IExecuteRequest {
    script: string;
}

interface ICodeRequest {
    path: string;
}

export interface ISourceCode {
    content: string;
    path: string;
}

export class ArmaDebugEngine extends EventEmitter {
    connected: boolean = false;
    initialized: boolean = false;

    messageQueue: IClientMessage[] = [];

    client: WebSocket | null = null;

    callStack?: ICallStackItem[];

    logging:boolean = false;
    verbose:boolean = false;

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

    connect(): Promise<void> {
        if (this.connected) {
            return Promise.resolve();
        }

        return new Promise<void>((resolve, reject) => {
            setTimeout(() => {
                reject('Timed out');
            }, 10000);

            this.on('connected', () => {
                resolve();
            });
            
            const ADE_PORT = 9002;
            this.client = new WebSocket(`ws://localhost:${ADE_PORT}`);
            this.client.on('open', () => {
                this.connected = true;
                this.sendCommand(this.nextHandle(), Commands.getVersionInfo);
                resolve();
            });

            this.client.on('close', () => {
                this.connected = false;
                this.initialized = false;
                this.client = null;
                this.emit('disconnected');
                reject('Closed');
            });

            this.client.on('message', (msg:string) => {
                this.receiveMessage(JSON.parse(msg) as IRemoteMessage);
                resolve();
            });
            
            this.client.on('error', (err:Error) => {
                if((err as any)?.code === 'ECONNREFUSED') {
                    this.error(`Could not connect to Arma Debug Engine`);
                } else {
                    this.error(`Socket error: ${err.message}`);
                }
                this.connected = false;
                this.client = null;
                reject(err.name);
            });
        });
    }

    end() {
        this.client?.close();
    }

    protected nextHandle():string { return (++this.nextRequestId).toString(); }

    addBreakpoint(breakpoint: IBreakpointRequest) {
        this.breakpoints[this.breakpointId++] = breakpoint;

        this.sendCommand(this.nextHandle(), Commands.addBreakpoint, breakpoint);

        return this.breakpointId - 1;
    }
    
    removeBreakpoint(breakpoint: IBreakpointRequest) {
        this.sendCommand(this.nextHandle(), Commands.delBreakpoint, breakpoint);
    }

    clearAllBreakpoints() {
        this.sendCommand(this.nextHandle(), Commands.clearAllBreakpoints);
    }

    clearFileBreakpoints(filename:string) {
        this.sendCommand(this.nextHandle(), Commands.clearFileBreakpoints, { filename });
    }

    clearBreakpoints(path: string) {
        this.l(`clearing ${JSON.stringify(this.breakpoints)} breakpoints for ${path}`);
        Object.entries(this.breakpoints).forEach((value: [string, IBreakpointRequest]) => {
            this.l(`clearing breakpoint for ${path}: ${value}`);
            let breakpoint = value[1]; //this.breakpoints[index] as IBreakpointRequest;
            if (breakpoint.filename && breakpoint.filename.toLowerCase() === path.toLowerCase()) {
                this.removeBreakpoint(breakpoint);
                delete this.breakpoints[+value[0]];
            }
        });
    }

    setExceptionFilter(filters: number[]) {
        this.sendCommand(this.nextHandle(), Commands.SetExceptionFilter, { "scriptErrFilters": filters });
	}

    pause() {
        this.sendCommand(this.nextHandle(), Commands.haltNow);
    }

    continue(type: ContinueExecutionType = ContinueExecutionType.Continue) {
        this.sendCommand(this.nextHandle(), Commands.BPContinue, type);
    }


    getVariable(scope: VariableScope, name: string): Promise<IVariable | null> {
        return this.getVariables(scope, [name]).then(vars => {
            if(vars) {
                return vars[0];
            }
            return null;
        }).catch(err => null);
    }


    executeRaw(cmd: string): Promise<string> {
        return new Promise((resolve, reject) => {
            setTimeout(() => reject('Timed out'), 10000);
            try {
                let json = JSON.parse(cmd);
                json.handle = this.nextHandle();
                this.send(json);
                resolve("");
            } catch (error) {
                reject(error);
            }
        });
    }

    evaluate(script: string): Promise<IValue> {
        return new Promise((resolve, reject) => {
            setTimeout(() => reject('Timed out'), 10000);
            let request:IExecuteRequest = { 
                script
            };
            let handle = this.nextHandle();
            this.once('eval'+handle, (data, error) => {
                if(error) {
                    return reject(error);
                } else {
                    return resolve(data as IValue);
                }
            });
            this.sendCommand(handle, Commands.ExecuteCode, request);
        });
    }

    getVariables(scope: VariableScope, names: string[]): Promise<IVariable[] | null> {
        return new Promise((resolve, reject) => {
            setTimeout(() => reject('Timed out'), 5000);
            let request:IVariableRequest = { 
                scope,
                name: names
            };
            let handle = this.nextHandle();
            this.once('variable'+handle, data => {
                return resolve(data as IVariable[]);
            });
            this.sendCommand(handle, Commands.getVariable, request);
        });
    }

    getVariablesInScope(scope: VariableScope, ): Promise<any> {
        return new Promise((resolve, reject) => {
            setTimeout(() => reject('Timed out'), 10000);
            let request:IVariableListRequest = { 
                scope
            };
            let handle = this.nextHandle();
            this.once('variables'+handle, data => resolve(data));
            this.sendCommand(handle, Commands.getAvailableVariables, request);
        });
    }

    getStackVariables(frame:number) {
        return (this.callStack && this.callStack.length > frame) ? 
            this.callStack.slice(0, frame+1).map(c => c.variables).reduceRight((prev, curr) => Object.assign({}, curr, prev), {})
            :
            null;
    }

    getCallStack() {
        return this.callStack;
    }

    getCode(path:string): Promise<ISourceCode> {
        return new Promise((resolve, reject) => {
            //setTimeout(() => reject('Timed out'), 10000);
            let request:ICodeRequest = { 
                path
            };
            let handle = this.nextHandle();
            this.once('load' + handle, message => {
                resolve(message as ISourceCode);
            });
            this.sendCommand(handle, Commands.LoadFile, request);
        });
    }

    private l(message: string) {
        if(this.logging || this.verbose) {
            this.emit('log', message);
        }
    }

    private v(message: string) {
        if(this.verbose) {
            this.l(message);
        }
    }

    private error(message: string) {
        this.emit('error', message);
    }

    private emitStep(type:string, message:IRemoteMessage, error?:IError) {
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

        if(error && this.callStack) {
            this.callStack.push({
                fileName: error.filename,
                fileOffset: error.fileOffset,
                contentSample: error.content,
                lastInstruction: {
                    fileOffset: error.fileOffset,
                    filename: error.filename,
                    name: error.message,
                    type: 'exception'
                }
            });
        }

        this.emit(type, error || message);
    }

    private receiveMessage(message: IRemoteMessage) {
        this.v("RECEIVED:");
        this.v(JSON.stringify(message));

        switch (message.command) {
            case RemoteCommands.versionInfo:
                this.initialized = true;
                this.emit('connected', message);
                this.messageQueue.forEach(msg => this.send(msg));
                this.messageQueue = [];
                break;
            
            case RemoteCommands.halt_step:
                this.emitStep('halt-step', message);
                break;

            case RemoteCommands.halt_breakpoint:
                this.emitStep('halt-breakpoint', message);
                break;

            case RemoteCommands.halt_error:
                this.emitStep('halt-error', message, message.error as IError);
                break;

            case RemoteCommands.halt_scriptAsserts:
                this.emitStep('halt-assert', message, message.error as IError);
                break;

            case RemoteCommands.halt_scriptHalt:
                this.emitStep('halt-halt', message, message.error as IError);
                break;

            case RemoteCommands.VariableReturn:
                this.emit('variable' + (message.handle || ''), message.data);
                break;

            case RemoteCommands.VariablesReturn:
                this.emit('variables' + (message.handle || ''), message.data);
                break;

            case RemoteCommands.VariablesReturn:
                this.emit('eval' + (message.handle || ''), message.data, message.error);
                break;

            case RemoteCommands.LoadFileResult:
                this.emit('load' + (message.handle || ''), message.data, message.error);
                break;

            default:
                this.emit((message.handle || ''), message);
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
        if (!this.connected || (data.command !== Commands.getVersionInfo && !this.initialized)) {
            this.messageQueue.push(data);
            return;
        }

        if (this.client) {
            this.v("SEND:");
            this.v(JSON.stringify(data));
            this.client.send(JSON.stringify(data) + '\n', err => {
                if(err) {
                    this.emit('error', err.message);
                };
            });
        } else {
            this.error("Client is invalid can't send!");
        }
    }
}