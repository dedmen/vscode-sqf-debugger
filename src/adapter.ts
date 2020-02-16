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
import { ArmaDebug, ICallStackItem } from './arma-debug';

export interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	//rptPath?: string
	missionRoot?: string,
	scriptPrefix?: string
}

export class SQFDebug extends DebugSession {
	private static THREAD_ID = 1;
	private static VARIABLES_ID = 256;

	//private monitor: RptMonitor;
	private debugger: ArmaDebug | null = null;

	private missionRoot: string = '';
	private scriptPrefix: string = 'mpmissions\\__cur_mp.altis';

	private variables: { name: string, scope: number }[] = [];

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
		// let localAppData = process.env['LOCALAPPDATA'];
		// if(!localAppData) {
		// 	this.sendEvent(new OutputEvent("LOCALAPPDATA environment variable is not defined"));
		// 	return;
		// 	//throw "LOCALAPPDATA environment variable is not defined";
		// };
		//response.
		this.log(`Launching...`);
		//let defaultPath = path.join(localAppData, 'Arma 3');
		//let messageFilter: RegExp | null = null;
		//let errorFilter: RegExp | null = null;

		
		this.missionRoot = args.missionRoot?.toLowerCase() || "";
		this.scriptPrefix = args.scriptPrefix?.toLowerCase() || "";
		
		//this.log(`Mission Root set to ${this.missionRoot}`);
		// try {
		// 	messageFilter = args.messageFilter ? new RegExp(args.messageFilter, 'i') : null;
		// } catch (ex) {
		// 	this.sendEvent(new OutputEvent("Failed to compile message filter expression: " + ex, "stderr"))
		// }

		// try {
		// 	errorFilter = args.errorFilter ? new RegExp(args.errorFilter, 'i') : null;
		// } catch (ex) {
		// 	this.sendEvent(new OutputEvent("Failed to compile error filter expression: " + ex, "stderr"))
		// }


		//this.sendEvent(new OutputEvent("Watching " + (args.rptPath || defaultPath) + "\n"));

		// this.monitor = new RptMonitor(args.rptPath || defaultPath);

		// this.monitor.addListener('message', (message: RptMessage) => {
		// 	if (!messageFilter || messageFilter.test(message.message)) {
		// 		this.sendEvent(new OutputEvent(message.message + "\n", "console"));
		// 	}
		// });

		// this.monitor.addListener('error', (error: RptError) => {
		// 	if (!errorFilter || errorFilter.test(error.message)) {
		// 		this.sendEvent(new OutputEvent(error.message + "\n\tat " + error.filename + ":" + error.line + "\n", "stderr"));
		// 	}
		// });

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

		//let missionRoot = ''; //workspace.getConfiguration('sqf-debugger').get<string>('missionRoot') ?? '';
		let path = args.source.path.toLowerCase();
		if(path.startsWith(this.missionRoot)) {
			path = path.substr(this.missionRoot.length);
		}
		path = `${this.scriptPrefix}${path}`;

		this.log(`Setting breakpoints for ${path}...`);

		//let id = args.source.path;

		// Lets try and remove the mission path from the start:
		//id.inde

		this.debugger?.clearBreakpoints(path);
		// this.debugger?.clearBreakpoints(id.toLowerCase().replace(this.missionRoot, ''));

		// Build new breakpoints
		let breakpoints: DebugProtocol.Breakpoint[] = args.breakpoints.map(breakpoint => {
			this.log(`Adding breakpoint at ${path}:${breakpoint.line}`);
			// let id = this.debugger?.addBreakpoint({
			// 	action: { code: null, basePath: null, type: 2 },
			// 	condition: null,
			// 	filename: path && path.toLowerCase() || null,
			// 	line: breakpoint.line - 1
			// });

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
		const stk = this.debugger?.getCallStack();
		
		if(stk) {
			this.log(`Stack trace requested`);
			//let path = this.scriptPrefix;

			this.log(`Setting breakpoints for ${path}...`);
			response.body = {
				stackFrames: stk.map((f, i) => { return this.getCallstackFrame(f, i); }).reverse(),
				totalFrames: stk.length
			};
		};
		this.sendResponse(response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments) {
		// const frameReference = args.frameId;
		const scopes = new Array<Scope>();
		scopes.push(new Scope("Stack", 1, false));
		scopes.push(new Scope("Local", 2, true));
		scopes.push(new Scope("MissionNamespace", 3, true));
		scopes.push(new Scope("UiNamespace", 4, true));
		scopes.push(new Scope("ProfileNamespace", 5, true));
		scopes.push(new Scope("ParsingNamespace", 6, true));

		response.body = {
			scopes
		};

		this.sendResponse(response);
	}

	protected variablesRequest (response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments) {
		const variables = new Array<DebugProtocol.Variable>();

		this.log(`Variables requested`);
		if (args.variablesReference >= SQFDebug.VARIABLES_ID) {
			this.log(`Variables requested 1`);
			const variable = this.variables[args.variablesReference - SQFDebug.VARIABLES_ID];

			this.debugger?.getVariable(variable.scope, variable.name)
				.then(data => {
					(data as any[]).forEach(rval => {
						variables.push({
							name: rval.name,
							value: rval.value.toString(),
							type: rval.type,
							variablesReference: 0
						});
					});

					response.body = {
						variables
					};
		
					this.sendResponse(response);
				});

		}

		if (args.variablesReference === 1) {
			this.log(`Variables requested 2`);
			const remoteVariables = this.debugger?.getCurrentVariables();
			if(remoteVariables) {
				Object.keys(remoteVariables).forEach(name => {
					const variable = remoteVariables[name];
					variables.push({
						name,
						value: variable.value.toString(),
						type: variable.type,
						variablesReference: 0
					});
				});
			}

			response.body = {
				variables
			};

			this.sendResponse(response);
		}

		if (args.variablesReference > 1) {
			this.log(`Variables requested 3`);
			// args.variablesReference is a scope
			this.debugger?.getVariables(Math.pow(2, args.variablesReference - 1))
				.then(vars => {
					if (vars) {
						Object.keys(vars).forEach(scope => {
							vars[scope].forEach((name:string) => {
								let index = this.variables.findIndex(v => v.name === name && v.scope === parseInt(scope));
								if (index < 0) {
									index = this.variables.length;
									this.variables.push({
										name, scope: parseInt(scope)
									});
								}

								variables.push({
									name,
									value: '',
									type: undefined,
									variablesReference: SQFDebug.VARIABLES_ID + index
								});
							});
						});
					}

					response.body = {
						variables
					};

					this.sendResponse(response);
				});
		}
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments) {
		this.log(`Continue execution requested`);
		this.debugger?.continue();
		this.sendResponse(response);
	}

	protected log(msg:string) {
		this.sendEvent(new OutputEvent(`${msg}\n`));
	}

}

DebugSession.run(SQFDebug);