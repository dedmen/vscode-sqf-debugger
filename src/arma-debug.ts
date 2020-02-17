import * as net from 'net';
import { EventEmitter } from 'events';

export interface IBreakpointRequest {
    action: { code: string | null, basePath: string | null, type: number };
    condition: string | null;
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

enum ContinueExecutionType {
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
    command: Commands;
    data: any;
}

export interface ICallStackItem {
    contentSample: string;
    fileName?: string;
    ip: string;
    lastInstruction: ICompiledInstruction,
    type: string;
    variables: {
        [key: string]: {
            type: 'string' | 'nil' | 'float' | 'array';
            value: string;
        }
    };
    fileOffset?: {
        0: number;
        1: number;
        2: number;
    };
    compiled: ICompiledInstruction[];
}

export interface IVariable {
    name?: string;
    value: string | number | IVariable[];
    type: string;
}

export class ArmaDebug extends EventEmitter {
    connected: boolean = false;
    initialized: boolean = false;

    messageQueue: IClientMessage[] = [];

    client: net.Socket | null = null;

    callStack?: ICallStackItem[];

    breakpoints: { [key: number]: IBreakpointRequest } = {};
    breakpointId = 0;

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
            this.sendCommand(Commands.Hello);
        });

        this.client.on('data', (data) => {
            this.receiveMessage(JSON.parse(data.toString()) as IRemoteMessage);
        });

        this.client.on('close', () => {
            this.connected = false;
            this.initialized = false;
            this.client = null;

            setTimeout(() => this.connect(), 1000);
        });
    }

    addBreakpoint(breakpoint: IBreakpointRequest) {
        this.breakpoints[this.breakpointId++] = breakpoint;

        this.sendCommand(Commands.AddBreakpoint, breakpoint);

        return this.breakpointId - 1;
    }

    removeBreakpoint(breakpoint: IBreakpointRequest) {
        this.sendCommand(Commands.RemoveBreakpoint, breakpoint);
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
        this.sendCommand(Commands.ContinueExecution, type);
    }

    getVariable(scope: VariableScope, name: string): Promise<IVariable> {
        return new Promise((resolve, reject) => {
            let request: { scope?: VariableScope; name: string[]; } = { name: [name] };
            if (scope) {
                request.scope = scope;
            }

            this.once('variable', data => resolve((data as IVariable[])[0]));
            this.sendCommand(Commands.GetVariable, request);
        });
    }

    getVariables(scope: VariableScope, names: string[]): Promise<IVariable[]> {
        return new Promise((resolve, reject) => {
            let request: { scope?: VariableScope; name: string[]; } = { name: names };
            if (scope) {
                request.scope = scope;
            }

            this.once('variable', data => resolve(data as IVariable[]));
            this.sendCommand(Commands.GetVariable, request);
        });
    }

    getVariablesInScope(scope: VariableScope, ): Promise<any> {
        return new Promise((resolve, reject) => {
            this.once('variables', data => resolve(data));

            this.sendCommand(Commands.GetAvailableVariables, { scope });
        });
    }

    getStackVariables(frame:number) {
        return this.callStack ? this.callStack[frame].variables : null;
    }

    getCallStack() {
        return this.callStack;
    }

    private l(message: string) {
        this.emit('log', message);
    }

    private receiveMessage(message: IRemoteMessage) {
        this.l("Received:");
        this.l(JSON.stringify(message));

        switch (message.command) {
            case RemoteCommands.VersionInfo:

                this.initialized = true;

                this.messageQueue.forEach(msg => this.send(msg));
                this.messageQueue = [];

                break;

            case RemoteCommands.HaltBreakpoint:

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

                this.emit('breakpoint', message.callstack);

                break;

            case RemoteCommands.VariableReturn:

                this.emit('variable', message.data);

                break;

            case RemoteCommands.VariablesReturn:

                this.emit('variables', message.data);

                break;
        }
    }

    private sendCommand(command: Commands, data: any = null) {
        return this.send({
            command,
            data
        });
    }

    private send(data: IClientMessage) {
        if (!this.connected || (data.command !== Commands.Hello && !this.initialized)) {
            this.messageQueue.push(data);
            return;
        }

        this.l("Send:");
        this.l(JSON.stringify(data));
        if (this.client) {
            this.client.write(JSON.stringify(data) + '\n');
        };
    }
}