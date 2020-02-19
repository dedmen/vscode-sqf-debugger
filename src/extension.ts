import * as vscode from 'vscode';
import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken } from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	//missionRoot = vscode.workspace.getConfiguration('sqf-debugger').get<string>('missionRoot') ?? '';
	//vscode.window.showInformationMessage(`sqf debugger config ${missionRoot}`);

	// register a configuration provider for 'mock' debug type
	//const provider = new SQFConfigurationProvider();
	//context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('sqf', provider));
};


// class SQFConfigurationProvider implements vscode.DebugConfigurationProvider {

// 	/**
// 	 * Massage a debug configuration just before a debug session is being launched,
// 	 * e.g. add all missing attributes to the debug configuration.
// 	 */
// 	resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {

// 		// // if launch.json is missing or empty
// 		// if (!config.type && !config.request && !config.name) {
// 		// 	const editor = vscode.window.activeTextEditor;
// 		// 	if (editor && editor.document.languageId === 'markdown') {
// 		// 		config.type = 'sqf';
// 		// 		config.name = 'Launch';
// 		// 		config.request = 'launch';
// 		// 		config.program = '${file}';
// 		// 		config.stopOnEntry = true;
// 		// 	}
// 		// }

// 		// if (!config.program) {
// 		// 	return vscode.window.showInformationMessage("Cannot find a program to debug").then(_ => {
// 		// 		return undefined;	// abort launch
// 		// 	});
// 		// }

// 		return config;
// 	}
// }
