import * as vscode from 'vscode';
import { GitHubService } from './services/githubService';
import { CodeQLService } from './services/codeqlService';
import { UiProvider } from './providers/uiProvider';
import { ResultsProvider } from './providers/resultsProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('CodeQL Scanner extension is now active!');

    // Initialize services
    const githubService = new GitHubService();
    const codeqlService = new CodeQLService(githubService);
    
    // Initialize providers
    const uiProvider = new UiProvider(context);
    const resultsProvider = new ResultsProvider();

    // Set up communication between providers
    uiProvider.setResultsProvider(resultsProvider);

    // Register webview provider for configuration
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('codeql-scanner.config', uiProvider)
    );

    // Register tree data provider for results
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('codeql-scanner.results', resultsProvider)
    );

    // Register commands
    const commands = [
        vscode.commands.registerCommand('codeql-scanner.scan', async () => {
            await handleCommand('scan', codeqlService, resultsProvider, uiProvider);
        }),
        vscode.commands.registerCommand('codeql-scanner.init', async () => {
            await handleCommand('init', codeqlService, resultsProvider, uiProvider);
        }),
        vscode.commands.registerCommand('codeql-scanner.analysis', async () => {
            await handleCommand('analysis', codeqlService, resultsProvider, uiProvider);
        }),
        vscode.commands.registerCommand('codeql-scanner.configure', async () => {
            await openConfigurationSettings();
        })
    ];

    context.subscriptions.push(...commands);

    // Set context for when results are available
    vscode.commands.executeCommand('setContext', 'codeql-scanner.hasResults', false);
}

async function handleCommand(
    command: 'scan' | 'init' | 'analysis',
    codeqlService: CodeQLService,
    resultsProvider: ResultsProvider,
    uiProvider?: UiProvider
) {
    try {
        // Check if GitHub token is configured
        const config = vscode.workspace.getConfiguration('codeql-scanner');
        const token = config.get<string>('github.token');
        
        if (!token) {
            const result = await vscode.window.showErrorMessage(
                'GitHub token is required. Please configure it in settings.',
                'Open Settings'
            );
            if (result === 'Open Settings') {
                await openConfigurationSettings();
            }
            return;
        }

        // Show progress
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `CodeQL ${command}`,
            cancellable: true
        }, async (progress, token) => {
            progress.report({ increment: 0, message: 'Starting...' });

            let results;
            switch (command) {
                case 'scan':
                    results = await codeqlService.runScan(progress, token);
                    if (results && results.length > 0) {
                        resultsProvider.setResults(results);
                        // Update UI provider with scan results
                        if (uiProvider) {
                            uiProvider.updateScanResults(results);
                        }
                        vscode.commands.executeCommand('setContext', 'codeql-scanner.hasResults', true);
                    } else if (uiProvider) {
                        // Update UI provider with empty results
                        uiProvider.updateScanResults([]);
                    }
                    break;
                case 'init':
                    await codeqlService.initRepository(progress, token);
                    break;
                case 'analysis':
                    await codeqlService.runAnalysis(progress, token);
                    break;
            }

            progress.report({ increment: 100, message: 'Completed!' });
        });

        // Refresh results view
        resultsProvider.refresh();

        vscode.window.showInformationMessage(`CodeQL ${command} completed successfully!`);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`CodeQL ${command} failed: ${errorMessage}`);
        console.error(`CodeQL ${command} error:`, error);
    }
}

async function openConfigurationSettings() {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'codeql-scanner');
}

export function deactivate() {}
