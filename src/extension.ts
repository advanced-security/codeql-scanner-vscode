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
        })
    ];

    context.subscriptions.push(...commands);

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
