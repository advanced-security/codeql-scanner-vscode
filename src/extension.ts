import * as vscode from 'vscode';
import { GitHubService } from './services/githubService';
import { CodeQLService } from './services/codeqlService';
import { UiProvider } from './providers/uiProvider';
import { ResultsProvider } from './providers/resultsProvider';
import { LoggerService } from './services/loggerService';

export async function activate(context: vscode.ExtensionContext) {
    const logger = LoggerService.getInstance();
    logger.info('Extension', 'CodeQL Scanner extension is now active!');

    // Initialize services
    const githubService = new GitHubService();
    const codeqlService = new CodeQLService(githubService);
    
    // Initialize providers
    const uiProvider = new UiProvider(context);
    const resultsProvider = new ResultsProvider();

    // Set up communication between providers
    uiProvider.setResultsProvider(resultsProvider);
    uiProvider.setCodeQLService(codeqlService);

    // Set up real-time results callback for immediate UI updates
    codeqlService.setResultsCallback((results) => {
        // Update both providers immediately when new results are available
        resultsProvider.setResults(results);
        uiProvider.updateScanResults(results);
        vscode.commands.executeCommand('setContext', 'codeql-scanner.hasResults', results.length > 0);
    });

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
        }),
        vscode.commands.registerCommand('codeql-scanner.showLogs', () => {
            const logger = LoggerService.getInstance();
            logger.show();
        }),
        vscode.commands.registerCommand('codeql-scanner.clearLogs', () => {
            const logger = LoggerService.getInstance();
            logger.clearLogs();
            vscode.window.showInformationMessage('CodeQL Scanner logs cleared.');
        }),
        vscode.commands.registerCommand('codeql-scanner.reloadSARIF', async () => {
            await autoLoadExistingSARIFFiles(codeqlService, resultsProvider, uiProvider);
        }),
        vscode.commands.registerCommand('codeql-scanner.clearDiagnostics', () => {
            resultsProvider.clearResults();
            vscode.window.showInformationMessage('CodeQL diagnostics cleared.');
        }),
        vscode.commands.registerCommand('codeql-scanner.copyFlowPath', async (item) => {
            if (item && item.result && item.result.flowSteps) {
                const flowPath = item.result.flowSteps.map((step: any, index: number) => {
                    const stepType = index === 0 ? 'Source' : 
                                   index === item.result.flowSteps.length - 1 ? 'Sink' : 'Step';
                    return `${stepType} ${index + 1}: ${step.file}:${step.startLine}${step.message ? ` - ${step.message}` : ''}`;
                }).join('\n');
                
                await vscode.env.clipboard.writeText(flowPath);
                vscode.window.showInformationMessage('Flow path copied to clipboard!');
            } else {
                vscode.window.showWarningMessage('No flow path available for this item.');
            }
        }),
        vscode.commands.registerCommand('codeql-scanner.navigateFlowSteps', async (item) => {
            if (item && item.result && item.result.flowSteps && item.result.flowSteps.length > 0) {
                const flowSteps = item.result.flowSteps;
                
                // Create quick pick items for each flow step
                interface FlowStepQuickPickItem extends vscode.QuickPickItem {
                    stepData: any;
                }
                
                const quickPickItems: FlowStepQuickPickItem[] = flowSteps.map((step: any, index: number) => {
                    const stepType = index === 0 ? 'Source' : 
                                   index === flowSteps.length - 1 ? 'Sink' : 'Step';
                    const fileName = step.file.split('/').pop() || 'unknown';
                    
                    return {
                        label: `${stepType} ${index + 1}: ${fileName}:${step.startLine}`,
                        description: step.message || '',
                        detail: step.file,
                        stepData: step
                    };
                });
                
                const selected = await vscode.window.showQuickPick(quickPickItems, {
                    placeHolder: 'Select a flow step to navigate to'
                });
                
                if (selected && selected.stepData) {
                    const step = selected.stepData;
                    const document = await vscode.workspace.openTextDocument(step.file);
                    const editor = await vscode.window.showTextDocument(document);
                    
                    const range = new vscode.Range(
                        step.startLine - 1,
                        step.startColumn - 1,
                        step.endLine - 1,
                        step.endColumn - 1
                    );
                    
                    editor.selection = new vscode.Selection(range.start, range.end);
                    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                }
            } else {
                vscode.window.showWarningMessage('No flow steps available for this item.');
            }
        })
    ];

    context.subscriptions.push(...commands);

    // Register providers for disposal
    context.subscriptions.push(resultsProvider);
    
    // Register logger disposal
    context.subscriptions.push({
        dispose: () => {
            LoggerService.getInstance().dispose();
        }
    });

    // Set context for when results are available
    vscode.commands.executeCommand('setContext', 'codeql-scanner.hasResults', false);

    // Auto-load existing SARIF files
    await autoLoadExistingSARIFFiles(codeqlService, resultsProvider, uiProvider);
}

async function handleCommand(
    command: 'scan' | 'init' | 'analysis',
    codeqlService: CodeQLService,
    resultsProvider: ResultsProvider,
    uiProvider?: UiProvider
) {
    const logger = LoggerService.getInstance();
    
    try {
        logger.logCommand(command, 'started');
        
        // Check if GitHub token is configured
        const config = vscode.workspace.getConfiguration('codeql-scanner');
        const token = config.get<string>('github.token');
        
        if (!token) {
            logger.warn('Extension', 'GitHub token not configured');
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
                    } else {
                        // Clear existing results and diagnostics
                        resultsProvider.clearResults();
                        if (uiProvider) {
                            uiProvider.updateScanResults([]);
                        }
                        vscode.commands.executeCommand('setContext', 'codeql-scanner.hasResults', false);
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

        logger.logCommand(command, 'completed');
        vscode.window.showInformationMessage(`CodeQL ${command} completed successfully!`);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.logCommand(command, 'failed', error);
        vscode.window.showErrorMessage(`CodeQL ${command} failed: ${errorMessage}`);
    }
}

async function openConfigurationSettings() {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'codeql-scanner');
}

async function autoLoadExistingSARIFFiles(
    codeqlService: CodeQLService,
    resultsProvider: ResultsProvider,
    uiProvider: UiProvider
) {
    const logger = LoggerService.getInstance();
    
    try {
        logger.info('Extension', 'Checking for existing SARIF files...');
        
        const existingResults = await codeqlService.loadExistingSARIFFiles();
        
        if (existingResults && existingResults.length > 0) {
            logger.info('Extension', `Found ${existingResults.length} existing results`);
            
            resultsProvider.setResults(existingResults);
            uiProvider.updateScanResults(existingResults);
            vscode.commands.executeCommand('setContext', 'codeql-scanner.hasResults', true);
            
            // Group results by language for better user feedback
            const languageGroups = existingResults.reduce((groups, result) => {
                const lang = result.language || 'unknown';
                groups[lang] = (groups[lang] || 0) + 1;
                return groups;
            }, {} as { [key: string]: number });
            
            const languageSummary = Object.entries(languageGroups)
                .map(([lang, count]) => `${lang}: ${count}`)
                .join(', ');
            
            vscode.window.showInformationMessage(
                `Loaded ${existingResults.length} existing CodeQL results (${languageSummary})`
            );
        } else {
            logger.info('Extension', 'No existing SARIF files found');
        }
    } catch (error) {
        logger.error('Extension', 'Failed to load existing SARIF files', error);
        // Don't show error to user as this is a background operation
        // But we could optionally show a debug message
        const config = vscode.workspace.getConfiguration('codeql-scanner');
        const showDebugMessages = config.get<boolean>('showDebugMessages', false);
        
        if (showDebugMessages) {
            vscode.window.showWarningMessage(
                `Failed to auto-load existing SARIF files: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }
}

export function deactivate() {}
