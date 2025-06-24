import * as vscode from 'vscode';
import { ResultsProvider } from './resultsProvider';
import { ScanResult } from '../services/codeqlService';
import { GitHubService } from '../services/githubService';
import { LoggerService } from '../services/loggerService';

export class UiProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'codeql-scanner.config';

    private _view?: vscode.WebviewView;
    private _scanResults: ScanResult[] = [];
    private _resultsProvider?: ResultsProvider;
    private _githubService: GitHubService;
    private logger: LoggerService;

    constructor(private readonly _extensionContext: vscode.ExtensionContext) {
        this._githubService = new GitHubService();
        this.logger = LoggerService.getInstance();
    }

    public setResultsProvider(resultsProvider: ResultsProvider): void {
        this._resultsProvider = resultsProvider;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionContext.extensionUri
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                  case "saveConfig":
                    this.saveConfiguration(message.config);
                    break;
                  case "loadConfig":
                    this.loadConfiguration();
                    break;
                  case "testConnection":
                    this.testGitHubConnection();
                    break;
                  case "runLocalScan":
                    this.runLocalScan();
                    break;
                  case "loadAlertsSummary":
                    this.loadAlertsSummary();
                    break;
                  case "fetchRemoteAlerts":
                    this.fetchRemoteAlerts();
                    break;
                }
            },
            undefined,
            this._extensionContext.subscriptions
        );

        // Load initial configuration
        this.loadConfiguration();
    }

    private async saveConfiguration(config: any) {
        this.logger.logServiceCall('UiProvider', 'saveConfiguration', 'started');
        const workspaceConfig = vscode.workspace.getConfiguration('codeql-scanner');
        
        try {
            await Promise.all([
                workspaceConfig.update('github.token', config.githubToken, vscode.ConfigurationTarget.Global),
                workspaceConfig.update('github.owner', config.githubOwner, vscode.ConfigurationTarget.Workspace),
                workspaceConfig.update('github.repo', config.githubRepo, vscode.ConfigurationTarget.Workspace),
                workspaceConfig.update('searchPaths', config.searchPaths, vscode.ConfigurationTarget.Workspace),
                workspaceConfig.update('suites', config.suites, vscode.ConfigurationTarget.Workspace),
                workspaceConfig.update('languages', config.languages, vscode.ConfigurationTarget.Workspace),
                workspaceConfig.update('codeqlPath', config.codeqlPath, vscode.ConfigurationTarget.Global),
                workspaceConfig.update('useLocalScan', config.useLocalScan, vscode.ConfigurationTarget.Workspace)
            ]);

            this.logger.logServiceCall('UiProvider', 'saveConfiguration', 'completed');
            this.logger.logConfiguration('UiProvider', { ...config, githubToken: '[REDACTED]' });

            this._view?.webview.postMessage({ 
                command: 'configSaved',
                success: true,
                message: 'Configuration saved successfully!'
            });

            vscode.window.showInformationMessage('CodeQL Scanner configuration saved!');
        } catch (error) {
            this.logger.logServiceCall('UiProvider', 'saveConfiguration', 'failed', error);
            this._view?.webview.postMessage({ 
                command: 'configSaved',
                success: false,
                message: `Failed to save configuration: ${error}`
            });
        }
    }

    private async loadConfiguration() {
        const config = vscode.workspace.getConfiguration('codeql-scanner');
        
        const configuration = {
            githubToken: config.get<string>('github.token', ''),
            githubOwner: config.get<string>('github.owner', ''),
            githubRepo: config.get<string>('github.repo', ''),
            searchPaths: config.get<string[]>('searchPaths', ['src/', 'lib/']),
            suites: config.get<string[]>('suites', ['security-extended', 'security-and-quality']),
            languages: config.get<string[]>('languages', []),
            codeqlPath: config.get<string>('codeqlPath', 'codeql'),
            useLocalScan: config.get<boolean>('useLocalScan', true)
        };

        this._view?.webview.postMessage({ 
            command: 'configLoaded',
            config: configuration
        });
    }

    private async testGitHubConnection() {
        this.logger.logServiceCall('UiProvider', 'testGitHubConnection', 'started');
        const config = vscode.workspace.getConfiguration('codeql-scanner');
        const token = config.get<string>('github.token');
        
        if (!token) {
            this.logger.warn('UiProvider', 'GitHub connection test failed: no token configured');
            this._view?.webview.postMessage({ 
                command: 'connectionTest',
                success: false,
                message: 'GitHub token is required'
            });
            return;
        }

        try {
            // Update the service with the current token
            this._githubService.updateToken(token);
            
            // Test the connection by getting repository info
            await this._githubService.getRepositoryInfo();
            
            this.logger.logServiceCall('UiProvider', 'testGitHubConnection', 'completed');
            this._view?.webview.postMessage({ 
                command: 'connectionTest',
                success: true,
                message: 'GitHub connection successful!'
            });
        } catch (error) {
            this.logger.logServiceCall('UiProvider', 'testGitHubConnection', 'failed', error);
            this._view?.webview.postMessage({ 
                command: 'connectionTest',
                success: false,
                message: `GitHub connection failed: ${error}`
            });
        }
    }

    private async runLocalScan() {
        try {
            this._view?.webview.postMessage({ 
                command: 'scanStarted',
                success: true,
                message: 'Starting local CodeQL scan...'
            });

            // Trigger the scan command
            await vscode.commands.executeCommand('codeql-scanner.scan');
            
            this._view?.webview.postMessage({ 
                command: 'scanCompleted',
                success: true,
                message: 'CodeQL scan completed successfully!'
            });
        } catch (error) {
            this._view?.webview.postMessage({ 
                command: 'scanCompleted',
                success: false,
                message: `CodeQL scan failed: ${error}`
            });
        }
    }

    private async fetchRemoteAlerts() {
        try {
            this._view?.webview.postMessage({ 
                command: 'fetchStarted',
                success: true,
                message: 'Fetching remote security alerts...'
            });

            const config = vscode.workspace.getConfiguration('codeql-scanner');
            const token = config.get<string>('github.token');
            const owner = config.get<string>('github.owner');
            const repo = config.get<string>('github.repo');

            if (!token || !owner || !repo) {
                throw new Error('GitHub configuration is incomplete. Please configure token, owner, and repo.');
            }

            // Update the service with the current token
            this._githubService.updateToken(token);

            // Use GitHubService to fetch CodeQL alerts
            const codeqlAlerts = await this._githubService.getCodeQLAlerts(owner, repo);

            // Convert GitHub alerts to our ScanResult format
            const scanResults = codeqlAlerts.map((alert: any) => ({
                ruleId: alert.rule?.id || 'unknown',
                severity: this.mapGitHubSeverityToLocal(alert.rule?.severity),
                message: alert.message?.text || alert.rule?.description || 'No description',
                location: {
                    file: alert.most_recent_instance?.location?.path || 'unknown',
                    startLine: alert.most_recent_instance?.location?.start_line || 1,
                    startColumn: alert.most_recent_instance?.location?.start_column || 1,
                    endLine: alert.most_recent_instance?.location?.end_line || 1,
                    endColumn: alert.most_recent_instance?.location?.end_column || 1
                }
            }));

            // Update the scan results and refresh summary
            this.updateScanResults(scanResults);
            
            // Also update the results provider if available
            if (this._resultsProvider) {
                this._resultsProvider.setResults(scanResults);
                vscode.commands.executeCommand('setContext', 'codeql-scanner.hasResults', scanResults.length > 0);
            }

            this._view?.webview.postMessage({ 
                command: 'fetchCompleted',
                success: true,
                message: `Fetched ${scanResults.length} CodeQL security alerts from GitHub`
            });

        } catch (error) {
            this._view?.webview.postMessage({ 
                command: 'fetchCompleted',
                success: false,
                message: `Failed to fetch remote alerts: ${error}`
            });
        }
    }

    private mapGitHubSeverityToLocal(severity?: string): string {
        if (!severity) return 'medium';
        
        switch (severity.toLowerCase()) {
            case 'critical':
                return 'critical';
            case 'high':
                return 'high';
            case 'medium':
            case 'moderate':
                return 'medium';
            case 'low':
            case 'note':
            case 'info':
                return 'low';
            default:
                return 'medium';
        }
    }

    public updateScanResults(results: ScanResult[]): void {
        this._scanResults = results;
        this.loadAlertsSummary();
    }

    private async loadAlertsSummary() {
        // If no scan results are stored locally, try to get them from results provider
        let resultsToUse = this._scanResults;
        if (resultsToUse.length === 0 && this._resultsProvider) {
            try {
                resultsToUse = this._resultsProvider.getResults();
            } catch (error) {
                this.logger.debug('UiProvider', 'No previous scan results available');
                resultsToUse = [];
            }
        }
        
        const summary = this.generateAlertsSummary(resultsToUse);
        
        this._view?.webview.postMessage({ 
            command: 'alertsSummaryLoaded',
            summary: summary
        });
    }

    private generateAlertsSummary(results: ScanResult[]): any {
        if (!results || results.length === 0) {
            return {
                total: 0,
                severityBreakdown: { critical: 0, high: 0, medium: 0, low: 0 },
                topRules: [],
                topFiles: [],
                scanDate: null
            };
        }

        // Group by severity
        const severityBreakdown: { [key: string]: number } = { critical: 0, high: 0, medium: 0, low: 0 };
        results.forEach(result => {
            const severity = result.severity || 'medium';
            if (severityBreakdown[severity] !== undefined) {
                severityBreakdown[severity]++;
            } else {
                severityBreakdown[severity] = 1;
            }
        });

        // Get top rules
        const ruleCount: { [key: string]: number } = {};
        results.forEach(result => {
            const ruleId = result.ruleId || 'unknown';
            ruleCount[ruleId] = (ruleCount[ruleId] || 0) + 1;
        });

        const topRules = Object.entries(ruleCount)
            .sort(([, a], [, b]) => (b as number) - (a as number))
            .slice(0, 5)
            .map(([rule, count]) => ({ rule, count }));

        // Get top files
        const fileCount: { [key: string]: number } = {};
        results.forEach(result => {
            const fileName = result.location?.file ? 
                result.location.file.split('/').pop() || 'unknown' : 'unknown';
            fileCount[fileName] = (fileCount[fileName] || 0) + 1;
        });

        const topFiles = Object.entries(fileCount)
            .sort(([, a], [, b]) => (b as number) - (a as number))
            .slice(0, 5)
            .map(([file, count]) => ({ file, count }));

        return {
            total: results.length,
            severityBreakdown: {
                critical: severityBreakdown.critical || 0,
                high: severityBreakdown.high || 0,
                medium: severityBreakdown.medium || 0,
                low: severityBreakdown.low || 0
            },
            topRules,
            topFiles,
            scanDate: new Date().toISOString()
        };
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CodeQL Scanner Configuration</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            margin: 0;
            padding: 20px;
        }
        
        .form-group {
            margin-bottom: 15px;
        }
        
        label {
            display: block;
            margin-bottom: 5px;
            font-weight: bold;
            color: var(--vscode-input-foreground);
        }
        
        input, textarea, select {
            width: 100%;
            padding: 8px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 3px;
            box-sizing: border-box;
        }
        
        input:focus, textarea:focus, select:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }
        
        button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 10px 15px;
            border-radius: 3px;
            cursor: pointer;
            margin-right: 10px;
            margin-bottom: 10px;
        }
        
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        
        button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }
        
        #scanButton {
            background-color: var(--vscode-button-secondaryBackground, #0e639c);
            color: var(--vscode-button-secondaryForeground, white);
            font-weight: bold;
        }
        
        #scanButton:hover:not(:disabled) {
            background-color: var(--vscode-button-secondaryHoverBackground, #1177bb);
        }
        
        #fetchButton {
            background-color: var(--vscode-button-secondaryBackground, #228b22);
            color: var(--vscode-button-secondaryForeground, white);
            font-weight: bold;
        }
        
        #fetchButton:hover:not(:disabled) {
            background-color: var(--vscode-button-secondaryHoverBackground, #32cd32);
        }
        
        .success {
            color: var(--vscode-terminal-ansiGreen);
        }
        
        .error {
            color: var(--vscode-errorForeground);
        }
        
        .array-input {
            min-height: 60px;
        }
        
        .help-text {
            font-size: 0.9em;
            color: var(--vscode-descriptionForeground);
            margin-top: 3px;
        }
        
        .section {
            margin-bottom: 25px;
            padding-bottom: 15px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        
        .section:last-child {
            border-bottom: none;
        }
        
        h3 {
            margin-top: 0;
            color: var(--vscode-foreground);
        }
        
        #message {
            margin-top: 15px;
            padding: 10px;
            border-radius: 3px;
            display: none;
        }
        
        .summary-section {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 5px;
            padding: 15px;
            margin-bottom: 20px;
        }
        
        .summary-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 15px;
        }
        
        .summary-card {
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 3px;
            padding: 12px;
            text-align: center;
        }
        
        .summary-number {
            font-size: 24px;
            font-weight: bold;
            color: var(--vscode-foreground);
        }
        
        .summary-label {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-top: 5px;
        }
        
        .severity-critical { color: #ff6b6b; font-weight: bold; }
        .severity-high { color: var(--vscode-errorForeground); }
        .severity-medium { color: var(--vscode-warningForeground); }
        .severity-low { color: var(--vscode-infoForeground); }
        
        .top-items {
            margin-top: 15px;
        }
        
        .top-items h4 {
            margin: 0 0 10px 0;
            font-size: 14px;
            color: var(--vscode-foreground);
        }
        
        .top-list {
            list-style: none;
            padding: 0;
            margin: 0;
        }
        
        .top-list li {
            display: flex;
            justify-content: space-between;
            padding: 5px 0;
            border-bottom: 1px solid var(--vscode-panel-border);
            font-size: 12px;
        }
        
        .top-list li:last-child {
            border-bottom: none;
        }
        
        .no-results {
            text-align: center;
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            padding: 20px;
        }
    </style>
</head>
<body>
    <h2>CodeQL Scanner Configuration</h2>

    <div class="section">
        <h3>Local CodeQL Scanner</h3>
        <button onclick="runLocalScan()" id="scanButton">🔍 Run Local CodeQL Scanner</button>
        <button onclick="fetchRemoteAlerts()" id="fetchButton">🔄 Fetch Remote Security Alerts</button>
    </div>

    <div class="section" id="summarySection" style="display: none;">
        <h3>🔒 Security Alerts Summary</h3>
        <div class="summary-section">
            <div class="summary-grid">
                <div class="summary-card">
                    <div class="summary-number" id="totalAlerts">0</div>
                    <div class="summary-label">Total Alerts</div>
                </div>
                <div class="summary-card">
                    <div class="summary-number severity-critical" id="criticalAlerts">0</div>
                    <div class="summary-label">Critical Severity</div>
                </div>
                <div class="summary-card">
                    <div class="summary-number severity-high" id="highAlerts">0</div>
                    <div class="summary-label">High Severity</div>
                </div>
                <div class="summary-card">
                    <div class="summary-number severity-medium" id="mediumAlerts">0</div>
                    <div class="summary-label">Medium Severity</div>
                </div>
                <div class="summary-card">
                    <div class="summary-number severity-low" id="lowAlerts">0</div>
                    <div class="summary-label">Low Severity</div>
                </div>
            </div>

            <div id="detailsSection" style="display: none;">
                <div class="top-items">
                    <h4>🔍 Top Vulnerability Types</h4>
                    <ul class="top-list" id="topRules"></ul>
                </div>
                
                <div class="top-items">
                    <h4>📁 Most Affected Files</h4>
                    <ul class="top-list" id="topFiles"></ul>
                </div>
                
                <div class="top-items" style="margin-top: 15px;">
                    <small style="color: var(--vscode-descriptionForeground);">
                        Last scan: <span id="scanDate">Never</span>
                    </small>
                </div>
            </div>
            
            <div id="noResultsMessage" class="no-results">
                No security alerts found. Run a scan to see results.
            </div>
        </div>
    </div>
    
    <div class="section">
        <h3>GitHub Configuration</h3>
        
        <div class="form-group">
            <label for="githubToken">GitHub Token:</label>
            <input type="password" id="githubToken" placeholder="ghp_...">
            <div class="help-text">Personal access token with repo and security_events scopes</div>
        </div>
        
        <div class="form-group">
            <label for="githubOwner">Repository Owner:</label>
            <input type="text" id="githubOwner" placeholder="username or organization">
        </div>
        
        <div class="form-group">
            <label for="githubRepo">Repository Name:</label>
            <input type="text" id="githubRepo" placeholder="repository-name">
        </div>
        
        <button onclick="testConnection()">Test Connection</button>
    </div>
    
    <div class="section">
        <h3>CodeQL CLI Configuration</h3>
        
        <div class="form-group">
            <label for="useLocalScan">
                <input type="checkbox" id="useLocalScan" style="width: auto; margin-right: 8px;">
                Use Local CodeQL CLI
            </label>
            <div class="help-text">Use local CodeQL CLI instead of GitHub Actions for scanning</div>
        </div>
        
        <div class="form-group">
            <label for="codeqlPath">CodeQL CLI Path:</label>
            <input type="text" id="codeqlPath" placeholder="codeql">
            <div class="help-text">Path to the CodeQL CLI executable (e.g., 'codeql' if in PATH, or full path)</div>
        </div>
    </div>
    
    <div class="section">
        <h3>Scan Configuration</h3>
        
        <div class="form-group">
            <label for="searchPaths">Search Paths:</label>
            <textarea id="searchPaths" class="array-input" placeholder="src/&#10;lib/&#10;app/"></textarea>
            <div class="help-text">One path per line. Paths to search for source code.</div>
        </div>
        
        <div class="form-group">
            <label for="suites">Query Suites:</label>
            <textarea id="suites" class="array-input" placeholder="security-extended&#10;security-and-quality"></textarea>
            <div class="help-text">One suite per line. Available: security-extended, security-and-quality, code-scanning</div>
        </div>
        
        <div class="form-group">
            <label for="languages">Languages:</label>
            <textarea id="languages" class="array-input" placeholder="javascript&#10;typescript&#10;python"></textarea>
            <div class="help-text">One language per line. Supported: javascript, typescript, python, java, csharp, cpp, go, ruby</div>
        </div>
    </div>
    
    <button onclick="saveConfig()">Save Configuration</button>
    <button onclick="loadConfig()">Reload Configuration</button>
    
    <div id="message"></div>

    <script>
        const vscode = acquireVsCodeApi();
        
        function saveConfig() {
            const config = {
                githubToken: document.getElementById('githubToken').value,
                githubOwner: document.getElementById('githubOwner').value,
                githubRepo: document.getElementById('githubRepo').value,
                searchPaths: document.getElementById('searchPaths').value.split('\\n').filter(p => p.trim()),
                suites: document.getElementById('suites').value.split('\\n').filter(s => s.trim()),
                languages: document.getElementById('languages').value.split('\\n').filter(l => l.trim()),
                codeqlPath: document.getElementById('codeqlPath').value,
                useLocalScan: document.getElementById('useLocalScan').checked
            };
            
            vscode.postMessage({
                command: 'saveConfig',
                config: config
            });
        }
        
        function loadConfig() {
            vscode.postMessage({ command: 'loadConfig' });
        }
        
        function testConnection() {
            vscode.postMessage({ command: 'testConnection' });
        }
        
        function runLocalScan() {
            const scanButton = document.getElementById('scanButton');
            scanButton.disabled = true;
            scanButton.textContent = '⏳ Scanning...';
            
            vscode.postMessage({ command: 'runLocalScan' });
        }
        function fetchRemoteAlerts() {
            const fetchButton = document.getElementById('fetchButton');
            if (fetchButton) {
                fetchButton.disabled = true;
                fetchButton.textContent = '⏳ Fetching Alerts...';
            }
            
            vscode.postMessage({ command: 'fetchRemoteAlerts' });
        }

        
        function showMessage(text, isError = false) {
            const messageEl = document.getElementById('message');
            messageEl.textContent = text;
            messageEl.className = isError ? 'error' : 'success';
            messageEl.style.display = 'block';
            
            setTimeout(() => {
                messageEl.style.display = 'none';
            }, 5000);
        }
        
        function updateAlertsSummary(summary) {
            const summarySection = document.getElementById('summarySection');
            const noResultsMessage = document.getElementById('noResultsMessage');
            const detailsSection = document.getElementById('detailsSection');
            
            if (summary.total === 0) {
                summarySection.style.display = 'block';
                noResultsMessage.style.display = 'block';
                detailsSection.style.display = 'none';
            } else {
                summarySection.style.display = 'block';
                noResultsMessage.style.display = 'none';
                detailsSection.style.display = 'block';
                
                // Update summary numbers
                document.getElementById('totalAlerts').textContent = summary.total;
                document.getElementById('criticalAlerts').textContent = summary.severityBreakdown.critical || 0;
                document.getElementById('highAlerts').textContent = summary.severityBreakdown.high || 0;
                document.getElementById('mediumAlerts').textContent = summary.severityBreakdown.medium || 0;
                document.getElementById('lowAlerts').textContent = summary.severityBreakdown.low || 0;
                
                // Update top rules
                const topRulesList = document.getElementById('topRules');
                topRulesList.innerHTML = '';
                summary.topRules.forEach(item => {
                    const li = document.createElement('li');
                    li.innerHTML = '<span>' + item.rule + '</span><span>' + item.count + '</span>';
                    topRulesList.appendChild(li);
                });
                
                // Update top files
                const topFilesList = document.getElementById('topFiles');
                topFilesList.innerHTML = '';
                summary.topFiles.forEach(item => {
                    const li = document.createElement('li');
                    li.innerHTML = '<span>' + item.file + '</span><span>' + item.count + '</span>';
                    topFilesList.appendChild(li);
                });
                
                // Update scan date
                if (summary.scanDate) {
                    const date = new Date(summary.scanDate);
                    document.getElementById('scanDate').textContent = date.toLocaleString();
                }
            }
        }
        
        // Handle messages from the extension
        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.command) {
                case 'configLoaded':
                    const config = message.config;
                    document.getElementById('githubToken').value = config.githubToken || '';
                    document.getElementById('githubOwner').value = config.githubOwner || '';
                    document.getElementById('githubRepo').value = config.githubRepo || '';
                    document.getElementById('searchPaths').value = config.searchPaths.join('\\n');
                    document.getElementById('suites').value = config.suites.join('\\n');
                    document.getElementById('languages').value = config.languages.join('\\n');
                    document.getElementById('codeqlPath').value = config.codeqlPath || 'codeql';
                    document.getElementById('useLocalScan').checked = config.useLocalScan !== false;
                    break;
                    
                case 'configSaved':
                    showMessage(message.message, !message.success);
                    break;
                    
                case 'connectionTest':
                    showMessage(message.message, !message.success);
                    break;
                    
                case 'scanStarted':
                    showMessage(message.message, false);
                    break;
                    
                case 'scanCompleted':
                    const scanButton = document.getElementById('scanButton');
                    scanButton.disabled = false;
                    scanButton.textContent = '🔍 Run Local CodeQL Scan';
                    showMessage(message.message, !message.success);
                    break;
                    
                case 'fetchStarted':
                    showMessage(message.message, false);
                    break;
                    
                case 'fetchCompleted':
                    const fetchButton = document.getElementById('fetchButton');
                    if (fetchButton) {
                        fetchButton.disabled = false;
                        fetchButton.textContent = '🔄 Fetch Remote Security Alerts';
                    }
                    showMessage(message.message, !message.success);
                    break;
                    
                case 'alertsSummaryLoaded':
                    updateAlertsSummary(message.summary);
                    break;
            }
        });
        
        // Load configuration on startup
        loadConfig();
        
        // Load alerts summary
        vscode.postMessage({ command: 'loadAlertsSummary' });
    </script>
</body>
</html>`;
    }
}
