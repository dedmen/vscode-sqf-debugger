/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { readFileSync } from 'fs';
import { EventEmitter } from 'events';
import { Socket, connect } from 'net';

export interface ADEBreakpoint {
	id: number;
	line: number;
}

/**
 * Arma Debug Engine Runtime
 */
export class ADERuntime extends EventEmitter {

	private _client:Socket;
	private _breakPoints = new Map<string, ADEBreakpoint[]>();
	private _breakpointId = 1;

	constructor() {
		super();
	}

	public connect() {
		this._client = connect("\\\\.\\pipe\\ArmaDebugEnginePipeIface");
	}

	public continue() {
	}

	public setBreakpoint(file:string, line:number) {
	}

	public clearBreakpoint(id:number) {
	}

	public step() {
	}

	public stepIn() {
	}

	public stepOut() {
	}

	public inspect(scopes:string[], ) {
	}

	// /**
	//  * Fire events if line has a breakpoint or the word 'exception' is found.
	//  * Returns true is execution needs to stop.
	//  */
	// private fireEventsForLine(ln: number, stepEvent?: string): boolean {

	// 	const line = this._sourceLines[ln].trim();

	// 	// if 'log(...)' found in source -> send argument to debug console
	// 	const matches = /log\((.*)\)/.exec(line);
	// 	if (matches && matches.length === 2) {
	// 		this.sendEvent('output', matches[1], this._sourceFile, ln, matches.index)
	// 	}

	// 	// if a word in a line matches a data breakpoint, fire a 'dataBreakpoint' event
	// 	const words = line.split(" ");
	// 	for (let word of words) {
	// 		if (this._breakAddresses.has(word)) {
	// 			this.sendEvent('stopOnDataBreakpoint');
	// 			return true;
	// 		}
	// 	}

	// 	// if word 'exception' found in source -> throw exception
	// 	if (line.indexOf('exception') >= 0) {
	// 		this.sendEvent('stopOnException');
	// 		return true;
	// 	}

	// 	// is there a breakpoint?
	// 	const breakpoints = this._breakPoints.get(this._sourceFile);
	// 	if (breakpoints) {
	// 		const bps = breakpoints.filter(bp => bp.line === ln);
	// 		if (bps.length > 0) {

	// 			// send 'stopped' event
	// 			this.sendEvent('stopOnBreakpoint');

	// 			// the following shows the use of 'breakpoint' events to update properties of a breakpoint in the UI
	// 			// if breakpoint is not yet verified, verify it now and send a 'breakpoint' update event
	// 			if (!bps[0].verified) {
	// 				bps[0].verified = true;
	// 				this.sendEvent('breakpointValidated', bps[0]);
	// 			}
	// 			return true;
	// 		}
	// 	}

	// 	// non-empty line
	// 	if (stepEvent && line.length > 0) {
	// 		this.sendEvent(stepEvent);
	// 		return true;
	// 	}

	// 	// nothing interesting found -> continue
	// 	return false;
	// }

	// private sendEvent(event: string, ... args: any[]) {
	// 	setImmediate(_ => {
	// 		this.emit(event, ...args);
	// 	});
	// }
}