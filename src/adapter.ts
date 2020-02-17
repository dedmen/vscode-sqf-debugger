import * as path from 'path';
import { missionRoot } from './extension';

import * as vscode from 'vscode';

import {
	DebugSession,
	InitializedEvent, StoppedEvent, OutputEvent,
	Thread, StackFrame, Scope, Source
	// TerminatedEvent, BreakpointEvent, Event, Handles, Breakpoint, Variable
} from 'vscode-debugadapter';

import { DebugProtocol } from 'vscode-debugprotocol';
// import { RptMonitor, RptError, RptMessage } from './debugger';
import { ArmaDebug, ICallStackItem, IVariable, VariableScope } from './arma-debug';
import { resolve } from 'dns';
import { stringify } from 'querystring';

export interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	//rptPath?: string
	missionRoot?: string,
	scriptPrefix?: string
}

export class SQFDebug extends DebugSession {
	private static THREAD_ID = 1;
	private static STACK_VARIABLES_ID = 200;
	private static VARIABLES_ID = 256;
	private static VARIABLE_EXPAND_ID = 1024 * 1024;

	//private monitor: RptMonitor;
	private debugger: ArmaDebug | null = null;

	private missionRoot: string = '';
	private scriptPrefix: string = '';

	private variables: { name: string, scope: VariableScope }[] = [];

	public constructor() {
		super();
		this.log('Constructing sqf debugger');
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(false);
	}

	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
		this.log('Initializing sqf debugger');
		//if(response.body) {
			//response.body.supportsConfigurationDoneRequest = true;
		//}

		this.debugger = new ArmaDebug();
		this.debugger.connect();
		this.debugger.on('breakpoint', () => {
			this.sendEvent(new StoppedEvent('breakpoint', SQFDebug.THREAD_ID));
		});
		this.debugger.on('log', (text) => {
			this.log(text);
		});

		this.sendResponse(response);

		//let config = vscode.workspace.getConfiguration('sqf-debugger');
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		response.body = {
			threads: [
				new Thread(SQFDebug.THREAD_ID, "thread 1")
			]
		};
		this.sendResponse(response);
	}

	protected launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): void {
		this.log(`Launching...`);
		
		this.missionRoot = args.missionRoot?.toLowerCase() || "";
		this.scriptPrefix = args.scriptPrefix?.toLowerCase() || "";

		this.sendResponse(response);

		this.sendEvent(new InitializedEvent());
	}

	protected setBreakPointsRequest (response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments) {
		// Remove previously set breakpoints for this file
		if(!args.source.path) {
			this.log("args.source.path not set");
			return;
		}
		if(!args.breakpoints) {
			this.log("args.breakpoints not set");
			return;
		}
		if(!this.debugger?.connected) {
			this.log("Debugger not connected");
			return;
		}

		let path = args.source.path.toLowerCase();
		if(path.startsWith(this.missionRoot)) {
			path = path.substr(this.missionRoot.length);
		}
		path = `${this.scriptPrefix}${path}`;

		this.log(`Setting breakpoints for ${path}...`);

		try {
			this.debugger?.clearBreakpoints(path);
		} catch (error) {
			this.log(`  exception clearing breakpoints for ${path}: ${error}`);
		}

		// Build new breakpoints
		let breakpoints: DebugProtocol.Breakpoint[] = args.breakpoints.map(breakpoint => {
			this.log(`Adding breakpoint at ${path}:${breakpoint.line}`);
			let id = this.debugger?.addBreakpoint({
				action: { code: null, basePath: null, type: 2 },
				condition: null,
				filename: path,
				line: breakpoint.line
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

	protected getCallstackFrame(srcFrame: ICallStackItem, idx:number) : StackFrame {

		var sourceFile = srcFrame.lastInstruction.filename.toLowerCase();
		if(sourceFile.startsWith(this.scriptPrefix)) {
			sourceFile = this.missionRoot + sourceFile.substr(this.scriptPrefix.length);
		}
		var source = new Source(path.basename(sourceFile), sourceFile);
		return new StackFrame(
			idx,
			srcFrame.lastInstruction.name,
			source,
			srcFrame.lastInstruction.fileOffset[0],
			srcFrame.lastInstruction.fileOffset[2]
		);
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments) {
		if(!this.debugger?.connected) {
			this.log("Debugger not connected");
			return null;
		}
		
		const stk = this.debugger?.getCallStack();
		
		if(stk) {
			this.log(`Stack trace requested`);

			response.body = {
				stackFrames: stk.map((f, i) => { return this.getCallstackFrame(f, i); }).reverse(),
				totalFrames: stk.length
			};
		};
		this.sendResponse(response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments) {
		const scopes = new Array<Scope>();
		scopes.push(new Scope("Stack", SQFDebug.STACK_VARIABLES_ID + args.frameId, false));
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

	protected expandVariable(id:number) : Promise<DebugProtocol.Variable[] | undefined > | undefined
	{
		// Add the variable to our variable index if it isn't there
		// let index = this.variables.findIndex(v => v.name === name && v.scope === parseInt(scope));
		// if (index < 0) {
		// 	index = this.variables.length;
		// 	this.variables.push({
		// 		name, scope: parseInt(scope)
		// 	});
		// }
		const variable = this.variables[id];
			
		return this.debugger?.getVariable(variable.scope, variable.name).then(rval => {
			if(rval.type === "string" && (rval.value as string).startsWith(ArmaDebug.OOP_PREFIX)) {
				const objectName = rval.value as string;
				this.log(`Resolving object ${objectName}`);
				// get object class name
				return this.debugger?.getVariable(VariableScope.MissionNamespace, objectName + ArmaDebug.MEMBER_SEPARATOR + ArmaDebug.OOP_PARENT_STR).then(className => {
					this.log(`Resolved class ${className.value} for object ${objectName}`);
					// get class member and static member lists
					return this.debugger?.getVariables(VariableScope.MissionNamespace, [
								ArmaDebug.OOP_PREFIX + className.value + ArmaDebug.SPECIAL_SEPARATOR + ArmaDebug.MEM_LIST_STR, 
								ArmaDebug.OOP_PREFIX + className.value + ArmaDebug.SPECIAL_SEPARATOR + ArmaDebug.STATIC_MEM_LIST_STR
							]).then(members => {
						// get object and class values for the members
						//this.log(`Resolved members ${JSON.stringify(members)} for object ${objectName}`);
						let instanceMembers = (members[0].value as IVariable[]).map(m => {
							// member list values are like [name, [attribute...]]...
							let memberName = (m.value as IVariable[])[0].value as string;
							return objectName + ArmaDebug.MEMBER_SEPARATOR + memberName;
						});
						this.log(`Class members for ${objectName}: ${JSON.stringify(instanceMembers)}`);
						let staticMembers = members[1].value? (members[1].value as IVariable[]).map(m => {
							// static member list values are like [name, [attribute...]]...
							let memberName = (m.value as IVariable[])[0].value as string;
							return ArmaDebug.OOP_PREFIX + className.value + ArmaDebug.STATIC_SEPARATOR + memberName;
						}) : [];
						this.log(`Static members for ${objectName}: ${JSON.stringify(staticMembers)}`);
						return this.debugger?.getVariables(VariableScope.MissionNamespace, instanceMembers.concat(staticMembers)).then(memberValues => {
							return memberValues.map(memberValue => {
								// Add the variable to our variable index if it isn't there
								let index = this.variables.findIndex(v => v.name === memberValue.name && v.scope === VariableScope.MissionNamespace);
								if (index === -1) {
									index = this.variables.length;
									this.variables.push({
										name: memberValue.name || '', 
										scope: VariableScope.MissionNamespace
									});
								};
								return this.resolveVariable(
									index, 
									VariableScope.MissionNamespace,
									memberValue.name?.substr(objectName.length + 1) || '',
									memberValue.type,
									memberValue.value
								);
								// return {
								// 	name: memberValue.name,
								// 	value: JSON.stringify(memberValue.value),
								// 	type: memberValue.type,
								// 	variablesReference: 0
								// } as DebugProtocol.Variable;
							});
						});
					});
				});
			// } else if(rval.type === "array") {
			// 	return Promise.resolve((JSON.parse(rval.value) as string[]).map(
			// 		(val, idx) => { 
			// 			return {
			// 				name: idx.toString(), 
			// 				value: val,
			// 				type: "",
			// 				variablesReference: 0
			// 			};
			// 		}
			// 	));
			} else {
				return Promise.resolve([{
					name: variable.name,
					value: rval.value,
					type: rval.type,
					variablesReference: 0
				} as DebugProtocol.Variable]);
			}
		});
	}

	protected indexVariable(name:string, scope:VariableScope) : number {
		let index = this.variables.findIndex(v => v.name === name && v.scope === scope);
		if (index < 0) {
			index = this.variables.length;
			this.variables.push({
				name, scope: scope
			});
		}
		return index;
	}
	
	protected resolveVariable(id:number, scope:VariableScope, name:string, type:string, value:string|number|IVariable[]) : DebugProtocol.Variable 
	{
		// // Add the variable to our variable index if it isn't there
		// let index = this.variables.findIndex(v => v.name === variable.name && v.scope === scope);
		// if (index === -1) {
		// 	index = this.variables.length;
		// 	this.variables.push({
		// 		name: variable.name, 
		// 		scope
		// 	});
		// };

		// Add the variable to our variable index if it isn't there
		if(type === "string" && (value as string).startsWith(ArmaDebug.OOP_PREFIX)) {
			return {
				name,
				value: value as string,
				type: "object",
				variablesReference: id + SQFDebug.VARIABLE_EXPAND_ID
			};
		} else {
			return {
				name,
				value: type === "string"? value as string : JSON.stringify(value),
				type,
				variablesReference: 0
			};
		}
	}

	protected variablesRequest (response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments) {
		if(!this.debugger?.connected) {
			this.log("Debugger not connected");
			return null;
		}
		
		if(args.variablesReference >= SQFDebug.VARIABLE_EXPAND_ID) {
			// Expanding a variable value by id
			let varIdx = args.variablesReference - SQFDebug.VARIABLE_EXPAND_ID;
			this.log(`Variable expansion of ${varIdx} requested`);
			
			const variable = this.variables[varIdx];
			
			this.debugger?.getVariable(variable.scope, variable.name).then(rval => {
				return this.expandVariable(varIdx);
			}).then(vars => {
				if(vars) {
					response.body = {
						variables: vars
					};
				}
				this.sendResponse(response);
			});
		} else if (args.variablesReference >= SQFDebug.VARIABLES_ID) {
			// Requesting a variable value by id
			let varIdx = args.variablesReference - SQFDebug.VARIABLES_ID;
			this.log(`Variable ${varIdx} requested`);
			
			const variable = this.variables[varIdx];
			
			this.debugger?.getVariable(variable.scope, variable.name).then(rval => {
				response.body = {
					variables: [this.resolveVariable(varIdx, variable.scope, rval.name || '', rval.type, rval.value)]
				};
				this.sendResponse(response);
			});
		} else if (args.variablesReference >= SQFDebug.STACK_VARIABLES_ID) {
			// Requesting variables from a specific stack frame
			let frame = args.variablesReference - SQFDebug.STACK_VARIABLES_ID;
			this.log(`Stackframe ${frame} variables requested`);
			
			const remoteVariables = this.debugger?.getStackVariables(frame);
			const variables = new Array<DebugProtocol.Variable>();

			if(remoteVariables) {
				Object.keys(remoteVariables).forEach(name => {
					const rval = remoteVariables[name];
					// Lets resolve oop objects
					// Add the variable to our variable index if it isn't there
					let index = this.indexVariable(name, VariableScope.Stack);
					variables.push(this.resolveVariable(index, VariableScope.Stack, name, rval.type, rval.value));
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
				const variables = new Array<DebugProtocol.Variable>();

				if (vars) {
					Object.keys(vars).forEach(scope => {
						vars[scope].forEach((name:string) => {
							// Add the variable to our variable index if it isn't there
							let index = this.indexVariable(name, parseInt(scope));
							variables.push({
								name,
								value: '',
								type: undefined,
								variablesReference: SQFDebug.VARIABLES_ID + index
							});
						});
					});
				}

				variables.sort((l, r) => { return l.name.localeCompare(r.name); });

				response.body = {
					variables
				};

				this.sendResponse(response);
			});
		}
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments) {
		this.log(`Continue execution requested`);
		if(!this.debugger?.connected) {
			this.log("Debugger not connected");
			return;
		}
		this.debugger?.continue();
		this.sendResponse(response);
	}

	protected log(msg:string) {
		this.sendEvent(new OutputEvent(`${msg}\n`));
	}

}

DebugSession.run(SQFDebug);