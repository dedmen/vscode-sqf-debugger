import * as vscode from 'vscode';
import * as path from 'path';

import {
	DebugSession,
	InitializedEvent, StoppedEvent, OutputEvent,
	Thread, StackFrame, Scope, Source, TerminatedEvent, BreakpointEvent
	// TerminatedEvent, BreakpointEvent, Event, Handles, Breakpoint, Variable
} from 'vscode-debugadapter';

import { DebugProtocol } from 'vscode-debugprotocol';
import { ArmaDebugEngine, ICallStackItem, IVariable, VariableScope, ScriptErrorType, IValue, ContinueExecutionType, BreakpointAction, IBreakpointActionExecCode, IBreakpointActionHalt, IBreakpointActionLogCallstack, IBreakpointConditionHitCount, IBreakpointConditionCode, BreakpointCondition, ISourceCode, IRemoteMessage, IError } from './arma-debug-engine';
import { trueCasePathSync } from 'true-case-path';
import { Message } from 'vscode-debugadapter/lib/messages';
import { existsSync } from 'fs';

export interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	//rptPath?: string
	missionRoot?: string,
	scriptPrefix?: string
}

interface ICachedVariable {
	name: string;
	parent?: string;
	scope: VariableScope;
	type?: string;
	value?: string | number | IValue[];
	id: number;
	presentationHint?: DebugProtocol.VariablePresentationHint;
}

//Partition function
function partition(array: any[], filter: (e: any, idx: number, arr: any[]) => boolean) {
	let pass: any = [], fail: any = [];
	array.forEach((e, idx, arr) => (filter(e, idx, arr) ? pass : fail).push(e));
	return [pass, fail];
}

interface ISource {
	id: number;
	path: string;
	code?: Promise<ISourceCode>;
}


function text_truncate(str: string):string {
	if (str.length > 40) {
		return str.substring(0, 40) + '…';
	} else {
		return str;
	}
};

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
	private getSourceFromADE: boolean = true;
	private allowEval: boolean = false;
	private enableOOPExtensions: boolean = true;

	public constructor() {
		super();
		this.log('Constructing sqf debugger');
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(false);

		const config = vscode.workspace.getConfiguration('sqf-debugger');
		this.logging = config.get<boolean>('logging', false);
		this.verbose = config.get<boolean>('verbose', false);
		this.getSourceFromADE = config.get<boolean>('getSourceFromADE', true);
		this.allowEval = config.get<boolean>('allowEval', false);
		this.enableOOPExtensions = config.get<boolean>('enableOOPExtensions', true);
	}

	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
		this.log('Initializing SQF Debugger');

		if (response.body) {
			response.body.supportsCancelRequest = false;
			
			response.body.supportsEvaluateForHovers = this.allowEval;

			// Breakpoints
			response.body.supportsDataBreakpoints = false;
			response.body.supportsConditionalBreakpoints = true;
			response.body.supportsLogPoints = true;
			//response.body.supportsDataBreakpoints
			//response.body.supportsBreakpointLocationsRequest //#TODO, iterate all instructions and collect lines and columns of instructions

			// Exception 
			response.body.exceptionBreakpointFilters = [
				{"filter":ScriptErrorType[ScriptErrorType.gen], "label":"Generic Error", "default":true},
				{"filter":ScriptErrorType[ScriptErrorType.expo], "label":"Exponent out of range", "default":true},
				{"filter":ScriptErrorType[ScriptErrorType.num], "label":"Invalid number in expression", "default":true},
				{"filter":ScriptErrorType[ScriptErrorType.var], "label":"Undefined variable in expressio", "default":true},
				{"filter":ScriptErrorType[ScriptErrorType.bad_var], "label":"Reserved variable in expression", "default":true},
				{"filter":ScriptErrorType[ScriptErrorType.div_zero], "label":"Zero divisor", "default":true},
				{"filter":ScriptErrorType[ScriptErrorType.type], "label":"Type %s, expected %s", "default":true},
				{"filter":ScriptErrorType[ScriptErrorType.name_space], "label":"Local variable in global space", "default":true},
				{"filter":ScriptErrorType[ScriptErrorType.dim], "label":"%d elements provided, %d expected", "default":true},
				{"filter":ScriptErrorType[ScriptErrorType.halt_function], "label":"Debugger breakpoint hit", "default":true},
				{"filter":ScriptErrorType[ScriptErrorType.foreign], "label":"Foreign error: %s", "default":true},
				{"filter":ScriptErrorType[ScriptErrorType.unhandled_exception], "label":"Unhandled exception: %s", "default":true},
				{"filter":ScriptErrorType[ScriptErrorType.stack_overflow], "label":"Stack Overflow", "default":true}
			];
			response.body.supportsExceptionOptions = false; // Seems not applicable to Arma
			//response.body.supportsExceptionInfoRequest = true; //#TODO


			response.body.supportsDisassembleRequest = true;
			//response.body.supportsSetVariable // todo
			//response.body.supportsModulesRequest = false; // This seems to not exist anymore?
			response.body.supportsLoadedSourcesRequest = true;



		}

		this.connect().then(() =>
			this.sendResponse(response)
		);
	}

	protected connect(): Promise<void> {
		if (this.debugger?.connected) {
			return Promise.resolve();
		}

		this.log('Connecting to Arma Debug Engine...');

		this.variables = [];

		this.debugger = new ArmaDebugEngine();
		this.debugger.logging = this.logging;
		this.debugger.verbose = this.verbose;

		// let connected = new Promise<boolean>((resolve, reject) => {
		// 	setTimeout(() => {
		// 		this.disconnect();
		// 		reject('Timed out');
		// 	}, 10000);
		// 	return this.debugger?.on('connected', () => {
		// 		this.variables = [];
		// 		this.sendEvent(new OutputEvent('connected'));
		// 		this.log('Connected to Arma Debug Engine');
		// 		resolve(true);
		// 	});
		// });

		this.debugger.on('halt-breakpoint', () => {
			this.variables = [];
			this.sendEvent(new StoppedEvent('breakpoint', SQFDebugSession.THREAD_ID));
		});
		this.debugger.on('halt-step', () => {
			this.variables = [];
			this.sendEvent(new StoppedEvent('step', SQFDebugSession.THREAD_ID));
		});
		this.debugger.on('halt-error', (err: IError) => {
			this.variables = [];
			this.sendEvent(new StoppedEvent('exception', SQFDebugSession.THREAD_ID, err.message));
		});
		this.debugger.on('halt-assert', (err: IError) => {
			this.variables = [];
			this.sendEvent(new StoppedEvent('assert', SQFDebugSession.THREAD_ID, err.message));
		});
		this.debugger.on('halt-halt', () => {
			this.variables = [];
			this.sendEvent(new StoppedEvent('halt', SQFDebugSession.THREAD_ID));
		});
		this.debugger.on('log', (text) => {
			this.log(text);
		});
		this.debugger.on('error', (text) => {
			vscode.window.showErrorMessage(text);
			this.log(text);
		});
		this.debugger.on('disconnected', () => {
			this.disconnect();
		});
		return this.debugger.connect().then(() => {
			this.variables = [];
			this.sendEvent(new OutputEvent('connected'));
			vscode.window.setStatusBarMessage('Connected to Arma Debug Engine');
			this.log('Connected to Arma Debug Engine');
			this.debugger?.clearAllBreakpoints();
		}).catch(err => {
			this.disconnect();
		});
	}

	protected disconnect() {
		if (this.debugger) {
			this.sendEvent(new TerminatedEvent());
			vscode.window.setStatusBarMessage('Disconnected from Arma Debug Engine');
			this.log('Disconnected from Arma Debug Engine');
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
		this.log(`Terminating request`);
		this.disconnect();
		this.sendResponse(response);
	}

	protected restartRequest(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments, request?: DebugProtocol.Request): void {
		this.log(`Restart request`);
		this.disconnect();
		this.connect();
		this.sendResponse(response);
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): void {
		this.log(`Disconnect request`);
		this.disconnect();
		this.sendResponse(response);
	}

	protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments, request?: DebugProtocol.Request): void {
		if (!this.debugger?.connected) {
			this.sendDebuggerNotConnected(response);
			return;
		}
		this.log(`Pause`);
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

	protected continue(response: DebugProtocol.NextResponse, type: ContinueExecutionType) {
		if (!this.debugger?.connected) {
			this.sendDebuggerNotConnected(response);
			return;
		}
		this.log(`Continue ${type}`);
		this.debugger.continue(type);
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

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments, request?: DebugProtocol.Request): void {
		if (!this.debugger?.connected) {
			this.sendDebuggerNotConnected(response);
			return;
		}
		if (!this.allowEval) {
			this.sendResponse(response);
		}
		if (args.expression && args.expression.charAt(0) === '\\') {
			this.debugger.executeRaw(args.expression.substr(1)).then(result => {
				//response.body.result = result;
				this.sendResponse(response);
			}).catch(err => {
				this.sendEvalError(response, args.expression, err);
			});
		} else {
			this.debugger.evaluate(args.expression).then(val => {
				response.body.result = this.valueToString(val.value, val.type);
				this.sendResponse(response);
			}).catch(err => {
				this.sendEvalError(response, args.expression, err);
			});
		}
	}

	protected sourceRequest(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments, request?: DebugProtocol.Request): void {
		this.log(`Source requested for ${args.source?.name} (${args.sourceReference})`);

		if (args.source && args.source.path) // It wants a file by path, grab its sourceReference id from cache
		{ 
			args.sourceReference = this.cacheSource(args.source.path).id
		} 

		// Get from cache by reference
		const source = this.getCachedSource(args.sourceReference);
		if (source?.code) {
			source.code.then(c => {
				response.body = { content: c.content };
				this.sendResponse(response);
			}).catch(err => {
				this.sendResolveError(response, source?.path || '', err);
			});
		} else {
			this.sendResolveError(response, source?.path || '', 'Source reference');
		}
	}

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments) {
		// Remove previously set breakpoints for this file

		if (!args.source.path && args.source.sourceReference) {
			// We need the path, but we only got a reference, look up the reference
			const source = this.getCachedSource(args.source.sourceReference);
			args.source.path = source?.path;
		}

		if (!args.source.path) {
			this.log("args.source.path not set");
			return;
		}

		if (!this.debugger?.connected) {
			this.sendDebuggerNotConnected(response);
			return;
		}

		// If the source file, came from Arma (via LoadFile request) then the path is not local and we don't need to convert it
		const path = args.source.origin === 'arma' ? args.source.path : this.convertClientPathToDebugger(args.source.path);

		this.log(`Setting breakpoints for ${path}...`);

		this.debugger.clearFileBreakpoints(path);

		// Build new breakpoints
		let breakpoints: DebugProtocol.Breakpoint[] = args.breakpoints?.map(breakpoint => {
			this.log(`Adding breakpoint at ${path}:${breakpoint.line}`);

			let action: IBreakpointActionExecCode | IBreakpointActionHalt | IBreakpointActionLogCallstack;
			if (breakpoint.logMessage?.toLowerCase() === 'callstack') {
				action = { type: BreakpointAction.LogCallstack } as IBreakpointActionLogCallstack;
			} else if (breakpoint.logMessage) {
				action = { type: BreakpointAction.ExecCode, code: `echo str(${breakpoint.logMessage})` } as IBreakpointActionExecCode;
			} else {
				action = { type: BreakpointAction.Halt };
			}

			let condition: IBreakpointConditionCode | IBreakpointConditionHitCount | null = null;
			if (breakpoint.condition) {
				condition = { type: BreakpointCondition.Code, code: breakpoint.condition } as IBreakpointConditionCode;
			} else if (breakpoint.hitCondition) {
				condition = { type: BreakpointCondition.HitCount, count: +breakpoint.hitCondition } as IBreakpointConditionHitCount;
			}

			const id = this.debugger?.addBreakpoint({
				action,
				condition,
				filename: path,
				line: this.convertClientLineToDebugger(breakpoint.line)
			});

			return {
				verified: true,
				line: breakpoint.line,
				id,
				source: args.source
			};
		}) || [];

		response.body = {
			breakpoints
		};

		this.sendResponse(response);
	}

	protected setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments, request?: DebugProtocol.Request) {

		if (!this.debugger?.connected) {
			this.sendDebuggerNotConnected(response);
			return;
		}

		// Build new filter array
		let filters: number[] = args.filters?.map(filterName => {
			return ScriptErrorType[filterName as keyof typeof ScriptErrorType];
		}) || [];

		this.debugger?.setExceptionFilter(filters);

		response.body = {
			/*
			For backward compatibility both the breakpoints array and the enclosing body are optional.
			If these elements are missing a client is not able to show problems for individual exception breakpoints or filters.
			*/
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

	private static getStackframeName(instructionName:string, contentSample?: string) {
		// contentSample is no use, its just the first line of the block
		// if(contentSample) {
		// 	const clean = contentSample.replace('\n', ' ').trim();
		// 	if(clean) {
		// 		return text_truncate(clean);
		// 	}
		// }
		return text_truncate(instructionName.replace('\n', ' ').replace('operator', '').trim());
	}

	protected getCallstackFrame(srcFrame: ICallStackItem, idx: number): DebugProtocol.StackFrame {
		if (srcFrame.lastInstruction) {
			//return new StackFrame(
			//	idx,
			//	SQFDebugSession.getStackframeName(srcFrame.lastInstruction.name, srcFrame.contentSample),
			//	//text_truncate(srcFrame.contentSample ? srcFrame.contentSample : srcFrame.lastInstruction.name.replace('\n', ' ')),
			//	
			//	srcFrame.lastInstruction.filename !== '' ? this.createSource(srcFrame.lastInstruction.filename) : 
			//	(
			//		// If there is no filename, the debugger probably sends us full content
			//		srcFrame.content != null ? 
			//			new Source("unknownPath", undefined, this.cacheSourceNoFile(srcFrame.content).id, 'arma', 'sqf-debugger-data')
			//		:
			//			undefined
			//	),
			//	this.convertDebuggerLineToClient(srcFrame.lastInstruction.fileOffset[0]),
			//	this.convertDebuggerColumnToClient(srcFrame.lastInstruction.fileOffset[2]),
			//);

			return {
				id: idx,
				name: SQFDebugSession.getStackframeName(srcFrame.lastInstruction.name, srcFrame.contentSample),
				//text_truncate(srcFrame.contentSample ? srcFrame.contentSample : srcFrame.lastInstruction.name.replace('\n', ' ')),
				
				source: srcFrame.lastInstruction.filename !== '' ? this.createSource(srcFrame.lastInstruction.filename) : 
				(
					// If there is no filename, the debugger probably sends us full content
					srcFrame.content != null ? 
						new Source("unknownPath", undefined, this.cacheSourceNoFile(srcFrame.content).id, 'arma', 'sqf-debugger-data')
					:
						undefined
				),
				line: this.convertDebuggerLineToClient(srcFrame.lastInstruction.fileOffset[0]),
				column: this.convertDebuggerColumnToClient(srcFrame.lastInstruction.fileOffset[2]),
				instructionPointerReference: `${srcFrame.instructionRef}_${srcFrame.ip}`
			};


		} else {
			return new StackFrame(idx, 'unknown');
		}
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments) {
		if (!this.debugger?.connected) {
			this.sendDebuggerNotConnected(response);
			return;
		}

		const stk = this.debugger.getCallStack();

		if (stk) {
			this.log(`Stack trace requested`);

			response.body = {
				stackFrames: stk.map((f, i) => { return this.getCallstackFrame(f, i); }).reverse(),
				totalFrames: stk.length
			};
			this.sendResponse(response);
		} else {
			this.sendResolveError(response, 'Callstack', 'No callstack found');
		}

	}

	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments) {
		if (!this.debugger?.connected) {
			this.sendDebuggerNotConnected(response);
			return;
		}

		if (args.variablesReference >= SQFDebugSession.VARIABLE_EXPAND_ID) {
			// Expanding a variable value by id
			const varIdx = args.variablesReference - SQFDebugSession.VARIABLE_EXPAND_ID;
			this.log(`Variable expansion of ${varIdx} requested`);

			this.expandVariable(varIdx).then(vars => {
				if (vars) {
					response.body = {
						variables: vars
					};
				}
				this.sendResponse(response);
			}).catch(err => {
				this.sendResolveError(response, '' + varIdx, err);
			});
		} else if (args.variablesReference >= SQFDebugSession.VARIABLES_ID) {
			// Requesting a variable value by id
			const varIdx = args.variablesReference - SQFDebugSession.VARIABLES_ID;
			this.log(`Variable ${varIdx} requested`);

			this.getVariableValueFromId(varIdx)?.then(rval => {
				response.body = {
					variables: [this.resolveVariable(rval)]
				};
				this.sendResponse(response);
			}).catch(err => {
				this.sendResolveError(response, '' + varIdx, err);
			});
		} else if (args.variablesReference >= SQFDebugSession.STACK_VARIABLES_ID) {
			// Requesting variables from a specific stack frame
			const frame = args.variablesReference - SQFDebugSession.STACK_VARIABLES_ID;
			this.log(`Stackframe ${frame} variables requested`);

			const remoteVariables = this.debugger.getStackVariables(frame);
			const variables = new Array<DebugProtocol.Variable>();

			if (remoteVariables) {
				Object.keys(remoteVariables).forEach(name => {
					const rval = remoteVariables[name];
					// Lets resolve oop objects
					// Add the variable to our variable index if it isn't there
					const variable = this.cacheVariable(name, VariableScope.Stack, undefined, rval.type, rval.value);
					// variables.push({
					// 	name,
					// 	value: '',
					// 	type: undefined,
					// 	variablesReference: SQFDebugSession.VARIABLES_ID + variable.id
					// });
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
			this.debugger.getVariablesInScope(args.variablesReference).then(vars => {
				this.log(`Scope ${args.variablesReference} variable list received: ${JSON.stringify(vars)}`);

				const variables = new Array<DebugProtocol.Variable>();
				if (vars) {
					Object.keys(vars).forEach(scope => {
						vars[scope]?.forEach((name: string) => {
							// Add the variable to our variable index if it isn't there
							const variable = this.cacheVariable(name, parseInt(scope), undefined);
							variables.push({
								name,
								value: '',
								type: undefined,
								variablesReference: SQFDebugSession.VARIABLES_ID + variable.id
							});
						});
					});
				}
				if (variables.length === 0) {
					variables.push({
						name: '<empty>',
						value: '',
						variablesReference: 0
					});
				};

				variables.sort((l, r) => { return l.name.localeCompare(r.name); });
				response.body = {
					variables
				};

				this.sendResponse(response);
			}).catch(err => {
				this.sendResolveError(response, '' + args.variablesReference, err);
			});
		}
	}

	protected loadedSourcesRequest(response: DebugProtocol.LoadedSourcesResponse, args: DebugProtocol.LoadedSourcesArguments, request?: DebugProtocol.Request) {
		if (!this.debugger?.connected) {
			this.sendDebuggerNotConnected(response);
			return;
		}

		const functions = this.debugger.getCodeVariables();

		functions.then(c => {
			const sources = c.map(f => {
				return new Source(path.basename(f.path.toLowerCase()), f.path.toLowerCase(), this.cacheSourceInsertNoFetch(f.path.toLowerCase()).id, 'arma', 'sqf-debugger-data' );
			})

			response.body = { sources: sources };
			this.sendResponse(response);
		}).catch(err => {
			this.sendResolveError(response, '', err);
		});
	}

	protected disassembleRequest(response: DebugProtocol.DisassembleResponse, args: DebugProtocol.DisassembleArguments, request?: DebugProtocol.Request) {
		this.log(`Disassemble request`);

		this.debugger?.getInstructionRefContent(args.memoryReference).then(c => {

			let instructions = c.map((inst, i) : DebugProtocol.DisassembledInstruction => {
				return {
					address: `${i}`,
					instruction: inst.name,
					line: inst.fileOffset[0],
					column: inst.fileOffset[2],
					location: i != 0 ? undefined : (
						this.createSource(inst.filename)
					)
				};
			});

			response.body = {
				 instructions:
				 [
					...
					(args.instructionOffset != null && args.instructionOffset < 0) ? (
						Array.from({length: -args.instructionOffset}, (_, i) : DebugProtocol.DisassembledInstruction => {
							return {
								address: `-${i}`,
								instruction: "XXX",
								presentationHint: 'invalid'
							}
						})
					) : [],
					...instructions,
					...Array.from({length: args.instructionCount - -(args.instructionOffset || 0) - instructions.length}, (_, i) : DebugProtocol.DisassembledInstruction => {
						return {
							address: `${instructions.length + i}`,
							instruction: "XXX",
							presentationHint: 'invalid'
						}
					})
				 ]
				 
				  };
			this.sendResponse(response);
		}).catch(err => {
			this.sendResolveError(response, '', err);
		});

	}

	protected customRequest(command: string, response: DebugProtocol.Response, args: any, request?: DebugProtocol.Request) {
		this.log(`Custom request? ${command}`);
	}


	// Implementation details --------------
	protected log(msg: string) {
		if (this.logging || this.verbose) {
			this.sendEvent(new OutputEvent(`${msg}\n`));
		};
	}

	protected logverbose(msg: string) {
		if (this.verbose) {
			this.sendEvent(new OutputEvent(`${msg}\n`));
		};
	}

	protected cacheVariable(name: string, scope: VariableScope, parent?: string, type?: string, value?: string | number | IValue[], presentationHint?: DebugProtocol.VariablePresentationHint): ICachedVariable {
		let index = this.variables.findIndex(v => v.name.toLowerCase() === name.toLowerCase() && v.scope === scope && v.parent?.toLowerCase() === parent?.toLowerCase());
		if (index < 0) {
			index = this.variables.length;

			// HACK to extraneous remove quotes from strings
			if (type === "string" && value) {
				const str = value as string;
				if (str.charAt(0) === '"' && str.charAt(str.length - 1) === '"') {
					value = str.substr(1, str.length - 2);
				}
			}
			if (!presentationHint) {
				if (this.isObject(type, value)) {
					presentationHint = { kind: 'class' };
				}
			}
			this.variables.push({ name: name, parent: parent, scope, id: index + 1, type, value, presentationHint });
		}
		return this.variables[index];
	}

	protected getVariableValues(names: string[], scope: VariableScope, parent: string): Promise<ICachedVariable[]> {
		if (names.length === 0) {
			return Promise.reject('No variable names provided');
		}

		const nonExisting = names.filter(name => {
			const variable = this.cacheVariable(name, scope, parent);
			return variable.type === undefined;
		});

		if (nonExisting.length === 0) {
			return Promise.resolve(names.map(name => this.cacheVariable(name, scope, parent)));
		}

		if (!this.debugger) {
			return Promise.reject('Debugger not connected');
		}

		return this.debugger.getVariables(scope, nonExisting).then(rval => {
			rval?.forEach((v, i) => {
				if (v.name) {
					const variable = this.cacheVariable(v.name, scope, parent);
					variable.type = v.type;
					variable.value = v.value;
				}
			});
			return names.map(name => this.cacheVariable(name, scope, parent)).filter(v => v.type !== undefined);
		});
	}

	protected getVariableValue(name: string, scope: VariableScope, parent: string): Promise<ICachedVariable | null> {
		return this.getVariableValues([name], scope, parent).then(vars => {
			return vars && vars.length > 0 ? vars[0] : null;
		});
	}

	protected getVariableValueFromId(id: number): Promise<ICachedVariable> {
		const variable = this.variables[id - 1];
		if (variable.type) {
			return Promise.resolve(variable);
		}
		if (!this.debugger) {
			return Promise.reject('Debugger not connected');
		}
		return this.debugger.getVariable(variable.scope, variable.name).then(rval => {
			variable.type = rval?.type || 'unknown';
			variable.value = rval?.value || 'unknown';
			return variable;
		});
	}

	protected getVariableUIName(name: string, parent?: string, presentationHint?:DebugProtocol.VariablePresentationHint): string {
		if (parent?.startsWith(ArmaDebugEngine.OOP_PREFIX)) {
			let prefix = '';
			if(presentationHint?.attributes) {
				prefix = '(' + presentationHint?.attributes.join(',') + ')';
			}
			const sub = name.substr(parent.length);
			if (sub.charAt(0) === '_') {
				return sub.substr(1);
			}
			return sub;
		}
		return name.substr(parent?.length || 0);
	}

	protected mapArrayValues(value: any, type?: string): string | string[] {
		if (type === 'array') {
			return (value as IValue[] || []).map(v => this.valueToString(v.value, v.type));
		} else {
			return this.valueToString(value);
		}
	}

	protected valueToString(value: any, type?: string): string {
		if (type === 'array') {
			if (!value) {
				return '[]';
			} else {
				const arr = value as IValue[] || [];
				if(arr.length === 1) {
					return `<1 item>` + '[' + arr.map(v => this.valueToString(v.value, v.type)).join(',') + ']';
				} else {
					return `<${arr.length} items>` + '[' + arr.map(v => this.valueToString(v.value, v.type)).join(',') + ']';
				}
			}
		}
		if (value === undefined) {
			return '<undefined>';
		}
		if (value === null) {
			return '<null>';
		}
		if (type === "string" && value === "") {
			return '""';
		}
		if (this.isObject(type, value)) {
			return value as string;
		}
		return JSON.stringify(value);
	}

	protected resolveVariable(variable: ICachedVariable): DebugProtocol.Variable {
		const name = this.getVariableUIName(variable.name, variable.parent, variable.presentationHint);

		// Add the variable to our variable index if it isn't there
		if (this.isObject(variable.type, variable.value)) {
			return {
				name,
				value: variable.value as string,
				type: "object",
				variablesReference: variable.id + SQFDebugSession.VARIABLE_EXPAND_ID,
				presentationHint: variable.presentationHint
			};
		} else if (variable.type === "array") {
			return {
				name,
				value: this.valueToString(variable.value, variable.type),
				//variable.value !== undefined ? JSON.stringify((variable.value as IArrayValue[] || []).map(v => v.value)) : 'empty',//`array of ${(value as any[]).length} items`,
				type: "array",
				variablesReference: (variable.value) ? variable.id + SQFDebugSession.VARIABLE_EXPAND_ID : 0,
				presentationHint: variable.presentationHint
			};
		} else {
			return {
				name,
				value: this.valueToString(variable.value, variable.type),
				type: variable.type || '',
				variablesReference: 0,
				presentationHint: variable.presentationHint
			};
		}
	}

	protected async expandObject(objectName: string): Promise<DebugProtocol.Variable[]> {
		const classNameVar = await this.getVariableValue(objectName + ArmaDebugEngine.MEMBER_SEPARATOR + ArmaDebugEngine.OOP_PARENT_STR, VariableScope.MissionNamespace, objectName);
		if (!classNameVar?.value) {
			throw new Error(`No class name found for ${objectName}`);
		}
		const className = classNameVar.value as string;
		this.log(`Resolved class ${className} for object ${objectName}`);
		const members = await this.getVariableValues([
			ArmaDebugEngine.OOP_PREFIX + className + ArmaDebugEngine.SPECIAL_SEPARATOR + ArmaDebugEngine.MEM_LIST_STR,
			ArmaDebugEngine.OOP_PREFIX + className + ArmaDebugEngine.SPECIAL_SEPARATOR + ArmaDebugEngine.STATIC_MEM_LIST_STR
		], VariableScope.MissionNamespace, objectName);

		//const instanceData = members[0]; //, staticData] = members;
		// get object and class values for the members
		//this.log(`Resolved members ${JSON.stringify(members)} for object ${objectName}`);
		const instanceMembers = members[0].value ? (members[0].value as IVariable[]).map(m => {
			// member list values are like [name, [attribute...]]...
			const memberName = ((m.value as IVariable[])[0].value as string);
			return objectName + ArmaDebugEngine.MEMBER_SEPARATOR + memberName;
		}) : [];

		this.logverbose(`Class members for ${objectName}: ${JSON.stringify(instanceMembers)}`);
		const staticMembers = members[1].value ? (members[1].value as IVariable[]).map(m => {
			// static member list values are like [name, [attribute...]]...
			const memberName = ((m.value as IVariable[])[0].value as string);
			return ArmaDebugEngine.OOP_PREFIX + className + ArmaDebugEngine.STATIC_SEPARATOR + memberName;
		}) : [];

		this.logverbose(`Static members for ${objectName}: ${JSON.stringify(staticMembers)}`);
		const memberValues = await this.getVariableValues(instanceMembers.concat(staticMembers), VariableScope.MissionNamespace, className as string);

		this.logverbose(`Member values for ${objectName}: ${JSON.stringify(memberValues)}`);
		return memberValues.map(memberValue => {
			// Add the variable to our variable index if it isn't there
			// objectName + '.' + memberValue.name?.substr(objectName.length + 1)
			let presentationHint:DebugProtocol.VariablePresentationHint = { kind: 'property' };
			let parent = objectName;
			if(staticMembers.includes(memberValue.name)) {
				presentationHint = { kind: 'property', attributes: ['static'] };
				parent = ArmaDebugEngine.OOP_PREFIX + className + ArmaDebugEngine.STATIC_SEPARATOR;
			};
			const variable = this.cacheVariable(memberValue.name || '', VariableScope.MissionNamespace, parent, memberValue.type, memberValue.value, presentationHint);
			return this.resolveVariable(variable);
		});
	}

	protected isObject(type?: string, value?: string | number | IValue[]): boolean {
		return this.enableOOPExtensions && type === "string" && (value as string)?.startsWith(ArmaDebugEngine.OOP_PREFIX);
	}

	protected async expandVariable(id: number): Promise<DebugProtocol.Variable[]> {
		const variable = await this.getVariableValueFromId(id);

		if (this.isObject(variable.type, variable.value)) {
			const objectName = (variable.value as string);
			this.log(`Resolving object ${objectName}`);

			// get object class name
			return this.expandObject(objectName);
		} else if (variable.type === "array") {
			if (variable.value) {
				return Promise.resolve((variable.value as IValue[]).map((val, idx) => {
					const name = `${variable.name}[${idx}]`;
					// If its an expandable type then cache it for expansion
					if (val.type === "array" || this.isObject(val.type, val.value)) {
						const elem = this.cacheVariable(name, variable.scope, variable.name, val.type, val.value);
						return this.resolveVariable(elem);
					}
					return {
						name: this.getVariableUIName(name, variable.name, variable.presentationHint),
						value: this.valueToString(val.value, val.type),
						type: val.type,
						variablesReference: 0
					} as DebugProtocol.Variable;
				}));
			} else {
				return Promise.resolve([]);
			}
		} else {
			return Promise.resolve([({
				name: variable.name,
				value: this.valueToString(variable.value, variable.type),
				type: variable.type,
				variablesReference: 0
			} as DebugProtocol.Variable)]);
		}
	}

	protected convertClientPathToDebugger(clientPath: string): string {
		let path = clientPath.toLowerCase();
		if (path.startsWith(this.missionRoot)) {
			path = path.substr(this.missionRoot.length);
		}
		if (!existsSync(`${this.missionRoot}${path}`))
			return clientPath; // Its not actually a local file, leave it as is (maybe a breakpoint from a script loaded from game)

		return `${this.scriptPrefix}${path}`;
	}

	protected convertDebuggerPathToClient(debuggerPath: string): string {
		let sourceFile = debuggerPath.toLowerCase();
		if (sourceFile.startsWith(this.scriptPrefix)) {
			sourceFile = this.missionRoot + sourceFile.substr(this.scriptPrefix.length);
		}
		return trueCasePathSync(sourceFile);
	}

	private cacheSourceInsertNoFetch(path: string): ISource {
		if (!this.getSourceFromADE) {
			return { id: 0, path };
		}

		let index = this.sourceIndex.findIndex(v => v.path.toLowerCase() === path.toLowerCase());
		if (index < 0) {
			index = this.sourceIndex.length;
			this.sourceIndex.push({ path, id: index + 1 });
		}

		const sourceCache = this.sourceIndex[index];
		// We do not fetch here, this is just to note that this file exists
		return sourceCache;
	}

	private cacheSource(path: string): ISource {
		if (!this.getSourceFromADE) {
			return { id: 0, path };
		}

		let index = this.sourceIndex.findIndex(v => v.path.toLowerCase() === path.toLowerCase());
		if (index < 0) {
			index = this.sourceIndex.length;
			this.sourceIndex.push({ path, id: index + 1 });
		}

		const sourceCache = this.sourceIndex[index];
		if (this.debugger && !sourceCache.code) {
			this.log(`Can't determine source path for ${path}, requesting from server`);
			sourceCache.code = this.debugger.getCode(path);
		}
		return sourceCache;
	}

	// Insert a source into the cache, without providing a filename, filename is unknown.
	//#TODO thus there is also no way to remove it from cache, unknown paths should be removed when debug session ends, or when execution is resumed, temporary sources are usually only present during a breakpoint
	private cacheSourceNoFile(fileContent: string): ISource {

		let index = -1; // We don't need to search because we can't find it. //#TODO We could optimize here and compare the code for equality, so we don't double cache the same code.
		if (index < 0) {
			index = this.sourceIndex.length;
			this.sourceIndex.push({ path: "unknownPath", id: index + 1 });
		}

		const sourceCache = this.sourceIndex[index];
		sourceCache.code = new Promise((resolve, reject) => {
			resolve({
				content: fileContent,
				path: "unknownPath"
			});
        });

		return sourceCache;
	}

	private getCachedSource(id: number): ISource | undefined {
		if (id === 0) {
			return undefined;
		}
		const index = id - 1;
		if (index < this.sourceIndex.length) {
			const sourceCache = this.sourceIndex[index];
			if (this.debugger && sourceCache.code === undefined) {
				sourceCache.code = this.debugger.getCode(sourceCache.path);
			}
			return sourceCache;
		} else {
			return undefined;
		}
	}

	private createSource(filePath?: string): Source | undefined {
		if (filePath) {
			let mappedPath;
			let sourceRef = 0;
			try {
				mappedPath = this.convertDebuggerPathToClient(filePath);
			} catch (error) {
				sourceRef = this.cacheSource(filePath.toLowerCase()).id;
				mappedPath = filePath.toLowerCase(); // This is annoying. But some code instructions have the path lowercased, other instructions have it uppercase. If it missmatches we will open the same source file twice
			}
			return new Source(path.basename(filePath), mappedPath, sourceRef, 'arma', 'sqf-debugger-data');
		} else {
			return undefined;
		}
	}

	// Error responses -----
	protected sendDebuggerNotConnected(response: DebugProtocol.Response) {
		this.sendErrorResponse(response, { format: 'Arma Debug Engine not connected', id: 0 });
	}

	protected sendResolveError(response: DebugProtocol.Response, item: string, msg: string) {
		this.sendErrorResponse(response, { format: `Could not resolve ${item}: ${msg}`, id: 1 });
	}

	protected sendEvalError(response: DebugProtocol.Response, item: string, msg: string) {
		this.sendErrorResponse(response, { format: `Could not evaluate ${item}: ${msg}`, id: 2 });
	}
}

DebugSession.run(SQFDebugSession);