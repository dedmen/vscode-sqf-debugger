'use strict';

import * as vscode from 'vscode';
import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken } from 'vscode';
import * as Net from 'net';
import { SQFDebugSession } from './sqf-debug';

/*
 * The compile time flag 'runMode' controls how the debug adapter is run.
 * 'server' is required for debugging the adapter
 */
const runMode: 'server' | 'inline' = 'inline';

export function activate(context: vscode.ExtensionContext) {
	//missionRoot = vscode.workspace.getConfiguration('sqf-debugger').get<string>('missionRoot') ?? '';
	//vscode.window.showInformationMessage(`sqf debugger config ${missionRoot}`);

	// register a configuration provider for 'sqf' debug type
	const provider = new SQFConfigurationProvider();
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('sqf', provider));

	// debug adapters can be run in different ways by using a vscode.DebugAdapterDescriptorFactory:
	let factory: vscode.DebugAdapterDescriptorFactory;
	switch (runMode) {
		case 'server':
			// run the debug adapter as a server inside the extension and communicating via a socket
			factory = new SQFDebugAdapterDescriptorFactory();
			break;

		case 'inline':
			// run the debug adapter inside the extension and directly talk to it
			factory = new InlineSQFDebugAdapterFactory();
			break;
	}

	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('sqf', factory));
	if ('dispose' in factory) {
		context.subscriptions.push(factory);
	}
};


// class DebugAdapterExecutableFactory implements vscode.DebugAdapterDescriptorFactory {

// 	// The following use of a DebugAdapter factory shows how to control what debug adapter executable is used.
// 	// Since the code implements the default behavior, it is absolutely not neccessary and we show it here only for educational purpose.

// 	createDebugAdapterDescriptor(_session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): ProviderResult<vscode.DebugAdapterDescriptor> {
// 		// param "executable" contains the executable optionally specified in the package.json (if any)

// 		// use the executable specified in the package.json if it exists or determine it based on some other information (e.g. the session)
// 		if (!executable) {
// 			const command = "absolute path to my DA executable";
// 			const args = [
// 				"some args",
// 				"another arg"
// 			];
// 			const options = {
// 				cwd: "working directory for executable",
// 				env: { "VAR": "some value" }
// 			};
// 			executable = new vscode.DebugAdapterExecutable(command, args, options);
// 		}

// 		// make VS Code launch the DA executable
// 		return executable;
// 	}
// }

class SQFDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {

	private server?: Net.Server;

	createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {

		if (!this.server) {
			// start listening on a random port
			this.server = Net.createServer(socket => {
				const session = new SQFDebugSession();
				session.setRunAsServer(true);
				session.start(<NodeJS.ReadableStream>socket, socket);
			}).listen(0);
		}

		// make VS Code connect to debug server
		return new vscode.DebugAdapterServer((<Net.AddressInfo>this.server.address()).port);
	}

	dispose() {
		if (this.server) {
			this.server.close();
		}
	}
}

class InlineSQFDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {

	createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
		return new vscode.DebugAdapterInlineImplementation(new SQFDebugSession());
	}
}

class SQFConfigurationProvider implements vscode.DebugConfigurationProvider {

	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
	 */
	resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {

		// if launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {
			const editor = vscode.window.activeTextEditor;
			if (editor && editor.document.languageId === 'sqf') {
				config.type = 'sqf';
				config.name = 'connect';
				config.request = 'launch';
				config.program = '${file}';
				config.missionRoot = '${workspaceFolder}';
				config.scriptPrefix = '${workspaceFolder}';
				config.stopOnEntry = true;
			}
		}

		// if (!config.program) {
		// 	return vscode.window.showInformationMessage("Cannot find a program to debug").then(_ => {
		// 		return undefined;	// abort launch
		// 	});
		// }

		return config;
	}
}
