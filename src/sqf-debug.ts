import * as vscode from 'vscode';
import * as path from 'path';

import {
	DebugSession,
	InitializedEvent, StoppedEvent, OutputEvent,
	Thread, StackFrame, Scope, Source
	// TerminatedEvent, BreakpointEvent, Event, Handles, Breakpoint, Variable
} from 'vscode-debugadapter';

import { DebugProtocol } from 'vscode-debugprotocol';
import { ArmaDebugEngine, ICallStackItem, IVariable, VariableScope, IValue, ContinueExecutionType, BreakpointAction, IBreakpointActionExecCode, IBreakpointActionHalt, IBreakpointActionLogCallstack, IBreakpointConditionHitCount, IBreakpointConditionCode, BreakpointCondition, ISourceCode } from './arma-debug-engine';
import { trueCasePathSync } from 'true-case-path';

export interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	//rptPath?: string
	missionRoot?: string,
	scriptPrefix?: string
	logging: boolean;
	verbose: boolean;
}

interface ICachedVariable {
	name: string;
	parent?: string;
	scope: VariableScope;
	type?: string;
	value?: string | number | IValue[];
	id: number;
}

//Partition function
function partition(array:any[], filter:(e:any, idx:number, arr:any[]) => boolean) {
	let pass:any = [], fail:any = [];
	array.forEach((e, idx, arr) => (filter(e, idx, arr) ? pass : fail).push(e));
	return [pass, fail];
}

interface ISource {
	id:number;
	path:string;
	code?:Promise<ISourceCode>;
}

export class SQFDebugSession extends DebugSession {
	private static THREAD_ID = 1;
	private static STACK_VARIABLES_ID = 200;
	private static VARIABLES_ID = 256;
	private static VARIABLE_EXPAND_ID = 1024 * 1024;

	//private monitor: RptMonitor;
	private debugger: ArmaDebugEngine | null = null;

	private missionRoot: string = '';
	private scriptPrefix: string = '';

	private variables: ICachedVariable[] = [];
	private sourceIndex: ISource[] = [];

	private logging: boolean = false;
	private verbose: boolean = false;

	public constructor() {
		super();
		this.log('Constructing sqf debugger');
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(false);

		let config = vscode.workspace.getConfiguration('sqf-debugger');
		this.logging = config.get<boolean>('logging', false);
		this.verbose = config.get<boolean>('verbose', false);
	}

	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
		this.log('Initializing sqf debugger');

		if(response.body) {
			response.body.supportsCancelRequest = false;
			response.body.supportsDataBreakpoints = false;
			response.body.supportsEvaluateForHovers = true;
		}

		this.connect().then(() => 
			this.sendResponse(response)
		);
	}

	protected connect() : Promise<boolean> {
		if(this.debugger?.connected) {
			return Promise.resolve(true);
		}

		this.log('Connecting to sqf debugger');

		this.variables = [];

		this.debugger = new ArmaDebugEngine();
		this.debugger.logging = this.logging;
		this.debugger.verbose = this.verbose;
		this.debugger.connect();

		let connected = new Promise<boolean>( resolve =>
			this.debugger?.on('connected', () => {
				this.variables = [];
				this.sendEvent(new OutputEvent('connected'));
				this.log('Connected to sqf debugger');
				resolve(true);
			})
		);

		this.debugger.on('halt-breakpoint', () => {
			this.variables = [];
			this.sendEvent(new StoppedEvent('breakpoint', SQFDebugSession.THREAD_ID));
		});
		this.debugger.on('halt-step', () => {
			this.variables = [];
			this.sendEvent(new StoppedEvent('step', SQFDebugSession.THREAD_ID));
		});
		this.debugger.on('halt-error', () => {
			this.variables = [];
			this.sendEvent(new StoppedEvent('exception', SQFDebugSession.THREAD_ID));
		});
		this.debugger.on('halt-assert', () => {
			this.variables = [];
			this.sendEvent(new StoppedEvent('assert', SQFDebugSession.THREAD_ID));
		});
		this.debugger.on('log', (text) => {
			this.log(text);
		});

		return connected;
	}

	protected disconnect() {
		if(this.debugger) {
			this.log('Disconnecting from sqf debugger');
			this.debugger.end();
			this.debugger = null;
		}
	}

	// Debugger API implementation --------------
	protected launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): void {
		this.log(`Launching`);

		this.missionRoot = args.missionRoot?.toLowerCase() || "";
		this.scriptPrefix = args.scriptPrefix?.toLowerCase() || "";

		this.sendResponse(response);

		this.sendEvent(new InitializedEvent());
	}

	protected terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments, request?: DebugProtocol.Request): void {
		this.disconnect();
		this.sendResponse(response);
	}

	protected restartRequest(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments, request?: DebugProtocol.Request): void {
		this.disconnect();
		this.connect();
		this.sendResponse(response);
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): void {
		this.disconnect();
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		response.body = {
			threads: [
				new Thread(SQFDebugSession.THREAD_ID, "thread 1")
			]
		};
		this.sendResponse(response);
	}

	protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments, request?: DebugProtocol.Request): void {
		this.log(`Pause`);
		if (!this.debugger?.connected) {
			this.log("Debugger not connected");
			return;
		}
		this.debugger?.pause();
		this.sendResponse(response);
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments) {
		this.continue(response, ContinueExecutionType.Continue);
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments, request?: DebugProtocol.Request): void {
		this.continue(response, ContinueExecutionType.StepOver);
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments, request?: DebugProtocol.Request): void {
		this.continue(response, ContinueExecutionType.StepInto);
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments, request?: DebugProtocol.Request): void {
		this.continue(response, ContinueExecutionType.StepOut);
	}

	protected continue(response: DebugProtocol.NextResponse, type:ContinueExecutionType) {
		this.log(`Continue ${type}`);
		if (!this.debugger?.connected) {
			this.log("Debugger not connected");
			return;
		}
		this.debugger?.continue(type);
		this.sendResponse(response);
	}

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments, request?: DebugProtocol.Request): void {
		this.sendResponse(response);
		// if (!this.debugger?.connected) {
		// 	this.log("Debugger not connected");
		// 	return;
		// }
		// this.debugger?.evaluate(args.expression).then(val => {
		// 	response.success = true;
		// 	response.body.result = this.valueToString(val.value, val.type);
		// 	this.sendResponse(response);
		// }, err => {
		// 	response.success = false;
		// 	response.message = err;
		// 	this.sendResponse(response);
		// });
	}

	protected sourceRequest(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments, request?: DebugProtocol.Request): void {
		this.log(`Source requested for ${args.source?.name} (${args.sourceReference})`);

		let code = this.getCachedSource(args.sourceReference)?.code;
		if(code) {
			code.then(c => {
				response.body.content = c.code;
				this.sendResponse(response);
			}, error => {
				response.success = false;
				response.message = `Source could not be retrieved`;
				this.sendResponse(response);
			});
		} else {
			response.success = false;
			response.message = `Cached source not found`;
			this.sendResponse(response);
		}
	}

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments) {
		// Remove previously set breakpoints for this file
		if (!args.source.path) {
			this.log("args.source.path not set");
			return;
		}
		if (!args.breakpoints) {
			this.log("args.breakpoints not set");
			return;
		}
		if (!this.debugger?.connected) {
			this.log("Debugger not connected");
			return;
		}

		let path = this.convertClientPathToDebugger(args.source.path);

		this.log(`Setting breakpoints for ${path}...`);

		try {
			this.debugger?.clearBreakpoints(path);
		} catch (error) {
			this.log(`  exception clearing breakpoints for ${path}: ${error}`);
		}

		// Build new breakpoints
		let breakpoints: DebugProtocol.Breakpoint[] = args.breakpoints.map(breakpoint => {
			this.log(`Adding breakpoint at ${path}:${breakpoint.line}`);

			let action:IBreakpointActionExecCode | IBreakpointActionHalt | IBreakpointActionLogCallstack;
			if(breakpoint.logMessage?.toLowerCase() === 'callstack') {
				action = { type: BreakpointAction.LogCallstack } as IBreakpointActionLogCallstack;
			} else if(breakpoint.logMessage) {
				action = { type: BreakpointAction.ExecCode, code: `echo str(${breakpoint.logMessage})` } as IBreakpointActionExecCode;
			} else {
				action = { type: BreakpointAction.Halt };
			}

			let condition:IBreakpointConditionCode | IBreakpointConditionHitCount | null = null;
			if(breakpoint.condition) {
				condition = { type: BreakpointCondition.Code, code: breakpoint.condition } as IBreakpointConditionCode;
			} else if(breakpoint.hitCondition) {
				condition = { type: BreakpointCondition.HitCount, count: +breakpoint.hitCondition } as IBreakpointConditionHitCount;
			}

			let id = this.debugger?.addBreakpoint({
				action,
				condition,
				filename: path,
				line: this.convertClientLineToDebugger(breakpoint.line)
			});

			return {
				verified: true,
				line: breakpoint.line,
				id
			};
		});

		response.body = {
			breakpoints
		};

		this.sendResponse(response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments) {
		const scopes = new Array<Scope>();
		scopes.push(new Scope("Stack", SQFDebugSession.STACK_VARIABLES_ID + args.frameId, false));
		scopes.push(new Scope("Local", VariableScope.Local, true));
		scopes.push(new Scope("MissionNamespace", VariableScope.MissionNamespace, true));
		scopes.push(new Scope("UiNamespace", VariableScope.UiNamespace, true));
		scopes.push(new Scope("ProfileNamespace", VariableScope.ProfileNamespace, true));
		scopes.push(new Scope("ParsingNamespace", VariableScope.ParsingNamespace, true));

		response.body = {
			scopes
		};

		this.sendResponse(response);
	}

	protected getCallstackFrame(srcFrame: ICallStackItem, idx: number): StackFrame {
		if(srcFrame.lastInstruction){ 
			return new StackFrame(
				idx,
				`${srcFrame.lastInstruction.name.replace('\n', ' ')} [${srcFrame.lastInstruction.type}]`,
				this.createSource(srcFrame.lastInstruction.filename),
				this.convertDebuggerLineToClient(srcFrame.lastInstruction.fileOffset[0]),
				this.convertDebuggerColumnToClient(srcFrame.lastInstruction.fileOffset[2])
			);
		} else {
			return new StackFrame(idx, 'unknown');
		}
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments) {
		if (!this.debugger?.connected) {
			this.log("Debugger not connected");
			return null;
		}

		const stk = this.debugger?.getCallStack();

		if (stk) {
			this.log(`Stack trace requested`);

			response.body = {
				stackFrames: stk.map((f, i) => { return this.getCallstackFrame(f, i); }).reverse(),
				totalFrames: stk.length
			};
		};
		this.sendResponse(response);
	}

	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments) {
		if (!this.debugger?.connected) {
			this.log("Debugger not connected");
			return null;
		}

		if (args.variablesReference >= SQFDebugSession.VARIABLE_EXPAND_ID) {
			// Expanding a variable value by id
			let varIdx = args.variablesReference - SQFDebugSession.VARIABLE_EXPAND_ID;
			this.log(`Variable expansion of ${varIdx} requested`);

			this.expandVariable(varIdx)?.then(vars => {
				if (vars) {
					response.body = {
						variables: vars
					};
				}
				this.sendResponse(response);
			}) || this.sendResponse(response);
		} else if (args.variablesReference >= SQFDebugSession.VARIABLES_ID) {
			// Requesting a variable value by id
			let varIdx = args.variablesReference - SQFDebugSession.VARIABLES_ID;
			this.log(`Variable ${varIdx} requested`);

			this.getVariableValueFromId(varIdx)?.then(rval => {
				response.body = {
					variables: [this.resolveVariable(rval)]
				};
				this.sendResponse(response);
			}) || this.sendResponse(response);
		} else if (args.variablesReference >= SQFDebugSession.STACK_VARIABLES_ID) {
			// Requesting variables from a specific stack frame
			let frame = args.variablesReference - SQFDebugSession.STACK_VARIABLES_ID;
			this.log(`Stackframe ${frame} variables requested`);

			const remoteVariables = this.debugger?.getStackVariables(frame);
			const variables = new Array<DebugProtocol.Variable>();

			if (remoteVariables) {
				Object.keys(remoteVariables).forEach(name => {
					const rval = remoteVariables[name];
					// Lets resolve oop objects
					// Add the variable to our variable index if it isn't there
					const variable = this.cacheVariable(name, VariableScope.Stack, undefined, rval.type, rval.value);
					variables.push(this.resolveVariable(variable));
				});
			}

			variables.sort((l, r) => { return l.name.localeCompare(r.name); });

			response.body = {
				variables
			};

			this.sendResponse(response);
		} else {
			// Requesting variable list for a specific scope
			this.log(`Scope ${args.variablesReference} variable list requested`);
			// args.variablesReference is a scope
			this.debugger?.getVariablesInScope(args.variablesReference).then(vars => {
				this.log(`Scope ${args.variablesReference} variable list received: ${JSON.stringify(vars)}`);
				const variables = new Array<DebugProtocol.Variable>();

				if (vars) {
					Object.keys(vars).forEach(scope => {
						vars[scope]?.forEach((name: string) => {
							// Add the variable to our variable index if it isn't there
							const variable = this.cacheVariable(name, parseInt(scope));
							variables.push({
								name,
								value: '',
								type: undefined,
								variablesReference: SQFDebugSession.VARIABLES_ID + variable.id
							});
						});
					});
				}

				variables.sort((l, r) => { return l.name.localeCompare(r.name); });

				response.body = {
					variables
				};

				this.sendResponse(response);
			}) || this.sendResponse(response);
		}
	}

	// Implementation details --------------
	protected log(msg: string) {
		if(this.logging) {
			this.sendEvent(new OutputEvent(`${msg}\n`));
		};
	}

	protected cacheVariable(name: string, scope: VariableScope, parent?: string, type?: string, value?: string | number | IValue[]): ICachedVariable {
		let index = this.variables.findIndex(v => v.name === name && v.scope === scope && v.parent === parent);
		if (index < 0) {
			index = this.variables.length;
			this.variables.push({ name: name, parent: parent, scope, id: index, type, value });
		}
		return this.variables[index];
	}

	protected getVariableValues(names: string[], scope: VariableScope, parent: string): Promise<ICachedVariable[]> | null {
		if (names.length === 0) {
			return null;
		}

		const nonExisting = names.filter(name => {
			const variable = this.cacheVariable(name, scope, parent);
			return variable.type === undefined;
		});

		if (nonExisting.length === 0) {
			return Promise.resolve(names.map(name => this.cacheVariable(name, scope, parent)));
		}

		return this.debugger?.getVariables(scope, nonExisting).then(rval => {
			rval?.forEach((v, i) => {
				if (v.name) {
					const variable = this.cacheVariable(v.name, scope, parent);
					variable.type = v.type;
					variable.value = v.value;
				}
			});
			return names.map(name => this.cacheVariable(name, scope, parent)).filter(v => v.type !== undefined);
		}) || null;
	}

	protected getVariableValue(name: string, scope: VariableScope, parent: string): Promise<ICachedVariable | null> | null {
		return this.getVariableValues([name], scope, parent)?.then(vars => vars && vars.length > 0? vars[0] : null) || null;
	}

	protected getVariableValueFromId(id: number): Promise<ICachedVariable> | null {
		const variable = this.variables[id];
		if (variable.type) {
			return Promise.resolve(variable);
		}
		return this.debugger?.getVariable(variable.scope, variable.name).then(rval => {
			variable.type = rval?.type || 'unknown';
			variable.value = rval?.value || 'unknown';
			return variable;
		}) || null;
	}

	protected getVariableUIName(name: string, parent?: string): string {
		if (parent?.startsWith(ArmaDebugEngine.OOP_PREFIX)) {
			return name.substr(parent.length + 1);
		}
		return name.substr(parent?.length || 0);
	}

	protected mapArrayValues(value:any, type?:string) : any {
		if(type === 'array') {
			return (value as IValue[] || []).map(v => this.mapArrayValues(v.value, v.type));
		}
		return value;
	}

	protected valueToString(value:any, type?:string) : string {
		if(type === 'array') {
			return !value? '[]' : JSON.stringify(this.mapArrayValues(value, type));
		}
		if(value === undefined) {
			return '<undefined>';
		}
		if(value === null) {
			return '<null>';
		}
		if(type === "string" && value === "") {
			return value === ""? `""` : value as string;
		}
		return JSON.stringify(value);
	}

	protected resolveVariable(variable: ICachedVariable): DebugProtocol.Variable {
		const name = this.getVariableUIName(variable.name, variable.parent);
		// Add the variable to our variable index if it isn't there
		if (this.isObject(variable.type, variable.value)) {
			return {
				name,
				value: variable.value as string,
				type: "object",
				variablesReference: variable.id + SQFDebugSession.VARIABLE_EXPAND_ID
			};
		} else if (variable.type === "array") {
			return {
				name,
				value: this.valueToString(variable.value, variable.type),
				//variable.value !== undefined ? JSON.stringify((variable.value as IArrayValue[] || []).map(v => v.value)) : 'empty',//`array of ${(value as any[]).length} items`,
				type: "array",
				variablesReference: (variable.value !== undefined) ? variable.id + SQFDebugSession.VARIABLE_EXPAND_ID : 0
			};
		} else {
			return {
				name,
				value: this.valueToString(variable.value, variable.type),
				type: variable.type || '',
				variablesReference: 0
			};
		}
	}

	protected expandObject(objectName: string): Promise<DebugProtocol.Variable[] | undefined> | undefined {
		return this.getVariableValue(objectName + ArmaDebugEngine.MEMBER_SEPARATOR + ArmaDebugEngine.OOP_PARENT_STR, VariableScope.MissionNamespace, objectName)?.then(className => {
			if(!className) {
				return undefined;
			}
			this.log(`Resolved class ${JSON.stringify(className)} for object ${objectName}`);

			// get class member and static member lists
			return this.getVariableValues([
				ArmaDebugEngine.OOP_PREFIX + className.value + ArmaDebugEngine.SPECIAL_SEPARATOR + ArmaDebugEngine.MEM_LIST_STR,
				ArmaDebugEngine.OOP_PREFIX + className.value + ArmaDebugEngine.SPECIAL_SEPARATOR + ArmaDebugEngine.STATIC_MEM_LIST_STR
			], VariableScope.MissionNamespace, objectName)?.then(members => {
				//const instanceData = members[0]; //, staticData] = members;
				// get object and class values for the members
				//this.log(`Resolved members ${JSON.stringify(members)} for object ${objectName}`);
				let instanceMembers = (members[0].value as IVariable[]).map(m => {
					// member list values are like [name, [attribute...]]...
					let memberName = (m.value as IVariable[])[0].value as string;
					return objectName + ArmaDebugEngine.MEMBER_SEPARATOR + memberName;
				});

				this.log(`Class members for ${objectName}: ${JSON.stringify(instanceMembers)}`);
				let staticMembers = members[1].value ? (members[1].value as IVariable[]).map(m => {
					// static member list values are like [name, [attribute...]]...
					let memberName = (m.value as IVariable[])[0].value as string;
					return ArmaDebugEngine.OOP_PREFIX + className.value + ArmaDebugEngine.STATIC_SEPARATOR + memberName;
				}) : [];

				this.log(`Static members for ${objectName}: ${JSON.stringify(staticMembers)}`);
				return this.getVariableValues(instanceMembers.concat(staticMembers), VariableScope.MissionNamespace, objectName)?.then(memberValues => {
					this.log(`Member values for ${objectName}: ${JSON.stringify(memberValues)}`);
					return memberValues.map(memberValue => {
						// Add the variable to our variable index if it isn't there
						// objectName + '.' + memberValue.name?.substr(objectName.length + 1)
						const variable = this.cacheVariable(
							memberValue.name || '',
							VariableScope.MissionNamespace,
							objectName,
							memberValue.type,
							memberValue.value
						);
						return this.resolveVariable(variable);
					});
				});
			});
		});
	}

	protected isObject(type?: string, value?: string | number | IValue[]): boolean {
		return type === "string" && (value as string).startsWith(ArmaDebugEngine.OOP_PREFIX);
	}

	protected expandVariable(id: number): Promise<DebugProtocol.Variable[] | undefined> | undefined {
		return this.getVariableValueFromId(id)?.then(variable => {
			if (this.isObject(variable.type, variable.value)) {
				const objectName = variable.value as string;
				this.log(`Resolving object ${objectName}`);
				// get object class name
				return this.expandObject(objectName);
			} else if (variable.type === "array") {
				return Promise.resolve((variable.value as IValue[])?.map(
					(val, idx) => {
						const name = `${variable.name}[${idx}]`;
						let partId = 0;
						// If its an expandable type then cache it for expansion
						if (val.type === "array" || this.isObject(val.type, val.value)) {
							const elem = this.cacheVariable(name, variable.scope, variable.name, val.type, val.value);
							return this.resolveVariable(elem);
						}
						return {
							name: this.getVariableUIName(name, variable.name),
							value: this.valueToString(val.value, val.type),
							type: val.type,
							variablesReference: partId
						} as DebugProtocol.Variable;
					}
				));
			} else {
				return Promise.resolve([{
					name: variable.name,
					value: this.valueToString(variable.value, variable.type),
					type: variable.type,
					variablesReference: 0
				} as DebugProtocol.Variable]);
			}
		});
	}

	protected convertClientPathToDebugger(clientPath: string): string
	{
		let path = clientPath.toLowerCase();
		if (path.startsWith(this.missionRoot)) {
			path = path.substr(this.missionRoot.length);
		}
		return `${this.scriptPrefix}${path}`;
	}

	protected convertDebuggerPathToClient(debuggerPath: string): string
	{
		let sourceFile = debuggerPath.toLowerCase();
		if (sourceFile.startsWith(this.scriptPrefix)) {
			sourceFile = this.missionRoot + sourceFile.substr(this.scriptPrefix.length);
		}
		return trueCasePathSync(sourceFile);
	}

	private cacheSource(path: string): ISource {
		let index = this.sourceIndex.findIndex(v => v.path === path);

		if (index < 0) {
			index = this.sourceIndex.length;
			this.sourceIndex.push({ path, id: index });
		}

		let sourceCache = this.sourceIndex[index];
		if(this.debugger && !sourceCache.code) {
			sourceCache.code = this.debugger.getCode(path);
		}
		return sourceCache;
	}

	private getCachedSource(id: number): ISource | undefined {
		if (id < this.sourceIndex.length) {
			let sourceCache = this.sourceIndex[id];
			if(this.debugger && !sourceCache.code) {
				sourceCache.code = this.debugger.getCode(sourceCache.path);
			}
			return sourceCache;
		} else {
			return undefined;
		}
	}

	private createSource(filePath?: string): Source | undefined {
		if(filePath) {
			let mappedPath;
			let sourceRef = 0;
			try {
				mappedPath = this.convertDebuggerPathToClient(filePath);
			} catch (error) {
				this.log(`Can't determine source path for ${filePath}, requesting from server`);
				//WIP crashes in arma currently
				// sourceRef = this.cacheSource(filePath).id;
			}
			return new Source(path.basename(filePath), mappedPath, sourceRef, 'arma', 'sqf-debugger-data');
		} else {
			return undefined;
		}
	}
}

DebugSession.run(SQFDebugSession);