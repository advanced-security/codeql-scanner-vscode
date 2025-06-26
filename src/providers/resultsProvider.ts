import * as vscode from 'vscode';
import { ScanResult, FlowStep } from '../services/codeqlService';
import { LoggerService } from '../services/loggerService';

export class ResultsProvider implements vscode.TreeDataProvider<ResultItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ResultItem | undefined | null | void> = new vscode.EventEmitter<ResultItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ResultItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private results: ScanResult[] = [];
    private diagnosticCollection: vscode.DiagnosticCollection;
    private hasBeenScanned: boolean = false;
    private logger: LoggerService;

    constructor() {
        // Create a diagnostic collection for CodeQL security issues
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('codeql-security');
        this.logger = LoggerService.getInstance();
    }

    refresh(): void {
        this.logger.debug('ResultsProvider', 'Refreshing tree view');
        this._onDidChangeTreeData.fire();
    }

    setResults(results: ScanResult[]): void {
        this.logger.logServiceCall('ResultsProvider', 'setResults', 'started', { count: results.length });
        
        // Count results by severity
        const severityCounts: { [severity: string]: number } = {};
        results.forEach(result => {
            const severity = result.severity || 'unknown';
            severityCounts[severity] = (severityCounts[severity] || 0) + 1;
        });
        
        this.results = results;
        this.hasBeenScanned = true;
        this.updateDiagnostics(results);
        this.refresh();
        
        // Generate comprehensive statistics if we have results
        if (results.length > 0) {
            this.logResultsStatistics();
        }
        
        this.logger.logServiceCall('ResultsProvider', 'setResults', 'completed', { 
            totalCount: results.length,
            severityCounts: severityCounts
        });
    }

    getResults(): ScanResult[] {
        this.logger.debug('ResultsProvider', 'Getting results', { count: this.results.length });
        return this.results;
    }

    clearResults(): void {
        this.logger.logServiceCall('ResultsProvider', 'clearResults', 'started');
        this.results = [];
        this.hasBeenScanned = false;
        this.diagnosticCollection.clear();
        this.refresh();
        this.logger.logServiceCall('ResultsProvider', 'clearResults', 'completed');
    }

    getTreeItem(element: ResultItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ResultItem): Thenable<ResultItem[]> {
        if (!element) {
            // Root level - group by language
            this.logger.debug('ResultsProvider', 'Getting root level tree items');
            
            if (!this.results || this.results.length === 0) {
                // Show different messages based on whether a scan has been run
                const message = this.hasBeenScanned 
                    ? '✅ No security alerts found'
                    : '🔍 Run a CodeQL scan to see security alerts';
                const tooltip = this.hasBeenScanned
                    ? 'No security vulnerabilities were found in the scanned code'
                    : 'Click "CodeQL: Run Scan" to analyze your code for security vulnerabilities';
                
                this.logger.debug('ResultsProvider', `Showing empty state: ${message}`);
                
                return Promise.resolve([
                    new ResultItem(
                        message,
                        vscode.TreeItemCollapsibleState.None,
                        'noResults',
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        tooltip
                    )
                ]);
            }
            
            const groups = this.groupByLanguage(this.results);
            
            this.logger.debug('ResultsProvider', 'Grouping results by language', {
                languages: Object.keys(groups),
                counts: Object.fromEntries(Object.entries(groups).map(([lang, results]) => [lang, results.length]))
            });
            
            return Promise.resolve(
                Object.entries(groups).map(([language, results]) => 
                    new ResultItem(
                        `${language.toUpperCase()} (${results.length})`,
                        vscode.TreeItemCollapsibleState.Expanded,
                        'language',
                        language,
                        results
                    )
                )
            );
        } else if (element.type === 'language') {
            // Second level - group by severity within language
            this.logger.debug('ResultsProvider', `Getting issues for language: ${element.language}`, {
                language: element.language,
                count: element.results?.length || 0
            });
            
            if (!element.results || element.results.length === 0) {
                // Show "no results" for this language
                this.logger.debug('ResultsProvider', `No results for language: ${element.language}`);
                return Promise.resolve([
                    new ResultItem(
                        '✅ No security alerts found',
                        vscode.TreeItemCollapsibleState.None,
                        'noResults',
                        element.language,
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        `No security vulnerabilities were found for ${element.language}`
                    )
                ]);
            }
            
            const severityGroups = this.groupBySeverity(element.results);
            const sortedSeverities = this.sortSeverityGroups(severityGroups);
            
            this.logger.debug('ResultsProvider', `Grouped issues by severity for ${element.language}`, {
                language: element.language,
                severities: Object.keys(severityGroups),
                counts: Object.fromEntries(Object.entries(severityGroups).map(([sev, results]) => [sev, results.length]))
            });
            
            return Promise.resolve(
                sortedSeverities.map(([severity, results]) => 
                    new ResultItem(
                        `${this.getSeverityDisplayName(severity)} (${results.length})`,
                        vscode.TreeItemCollapsibleState.Expanded,
                        'severity',
                        element.language,
                        results,
                        undefined,
                        severity
                    )
                )
            );
        } else if (element.type === 'severity') {
            // Third level - individual results
            this.logger.debug('ResultsProvider', `Getting individual results for ${element.language}/${element.severity}`, {
                language: element.language,
                severity: element.severity,
                count: element.results?.length || 0
            });
            
            return Promise.resolve(
                element.results!.map(result => 
                    new ResultItem(
                        `${result.ruleId}: ${result.message}`,
                        result.flowSteps && result.flowSteps.length > 0 
                            ? vscode.TreeItemCollapsibleState.Collapsed 
                            : vscode.TreeItemCollapsibleState.None,
                        'result',
                        element.language,
                        undefined,
                        result
                    )
                )
            );
        } else if (element.type === 'result' && element.result?.flowSteps) {
            // Fourth level - flow steps (hidden by default)
            const flowSteps = element.result.flowSteps;
            
            this.logger.debug('ResultsProvider', `Expanding flow steps for result: ${element.result.ruleId}`, {
                ruleId: element.result.ruleId,
                steps: flowSteps.length,
                file: element.result.location.file,
                line: element.result.location.startLine
            });
            
            return Promise.resolve(
                flowSteps.map((step, index) => {
                    const isSource = index === 0;
                    const isSink = index === flowSteps.length - 1;
                    const stepType = isSource ? 'Source' : isSink ? 'Sink' : 'Step';
                    const fileName = step.file.split('/').pop() || 'unknown';
                    
                    let label = `${stepType} ${index + 1}: ${fileName}:${step.startLine}`;
                    if (step.message) {
                        label += ` - ${step.message}`;
                    }
                    
                    return new ResultItem(
                        label,
                        vscode.TreeItemCollapsibleState.None,
                        'flowStep',
                        element.language,
                        undefined,
                        element.result,
                        undefined,
                        step
                    );
                })
            );
        }

        return Promise.resolve([]);
    }

    private groupByLanguage(results: ScanResult[]): { [language: string]: ScanResult[] } {
        this.logger.logServiceCall('ResultsProvider', 'groupByLanguage', 'started', { count: results.length });
        
        // Get configured languages from settings
        const config = vscode.workspace.getConfiguration("codeql-scanner");
        const configuredLanguages = config.get<string[]>("languages", []);
        
        // Start with results grouped by language
        const groups = results.reduce((groups, result) => {
            const language = result.language || 'unknown';
            if (!groups[language]) {
                groups[language] = [];
            }
            groups[language].push(result);
            return groups;
        }, {} as { [language: string]: ScanResult[] });
        
        // Add configured languages that have no results
        configuredLanguages.forEach(language => {
            if (!groups[language]) {
                groups[language] = [];
            }
        });
        
        this.logger.logServiceCall('ResultsProvider', 'groupByLanguage', 'completed', {
            languages: Object.keys(groups),
            configuredLanguages: configuredLanguages,
            counts: Object.fromEntries(Object.entries(groups).map(([lang, results]) => [lang, results.length]))
        });
        
        return groups;
    }

    private groupBySeverity(results: ScanResult[]): { [severity: string]: ScanResult[] } {
        this.logger.debug('ResultsProvider', 'Grouping results by severity', { count: results.length });
        
        const groups = results.reduce((groups, result) => {
            const severity = result.severity || 'unknown';
            if (!groups[severity]) {
                groups[severity] = [];
            }
            groups[severity].push(result);
            return groups;
        }, {} as { [severity: string]: ScanResult[] });
        
        this.logger.debug('ResultsProvider', 'Severity grouping completed', {
            severities: Object.keys(groups),
            counts: Object.fromEntries(Object.entries(groups).map(([sev, results]) => [sev, results.length]))
        });
        
        return groups;
    }

    private getSeverityDisplayName(severity: string): string {
        const severityMap: { [key: string]: string } = {
            'critical': '🔥 Critical',
            'high': '⚠️ High',
            'error': '⚠️ High',
            'medium': '⚡ Medium',
            'warning': '⚡ Medium',
            'low': 'ℹ️ Low',
            'info': 'ℹ️ Low',
            'unknown': '❓ Unknown'
        };
        return severityMap[severity] || `❓ ${severity.charAt(0).toUpperCase() + severity.slice(1)}`;
    }

    private sortSeverityGroups(severityGroups: { [severity: string]: ScanResult[] }): [string, ScanResult[]][] {
        this.logger.debug('ResultsProvider', 'Sorting severity groups', {
            severities: Object.keys(severityGroups)
        });
        
        const severityOrder = ['critical', 'high', 'error', 'medium', 'warning', 'low', 'info', 'unknown'];
        
        const sorted = Object.entries(severityGroups).sort(([a], [b]) => {
            const aIndex = severityOrder.indexOf(a);
            const bIndex = severityOrder.indexOf(b);
            
            // If severity not found in order, put it at the end
            if (aIndex === -1 && bIndex === -1) return a.localeCompare(b);
            if (aIndex === -1) return 1;
            if (bIndex === -1) return -1;
            
            return aIndex - bIndex;
        });
        
        this.logger.debug('ResultsProvider', 'Severity groups sorted', {
            sortedOrder: sorted.map(([severity]) => severity)
        });
        
        return sorted;
    }

    private updateDiagnostics(results: ScanResult[]): void {
        this.logger.logServiceCall('ResultsProvider', 'updateDiagnostics', 'started', { count: results.length });
        
        // Clear existing diagnostics
        this.diagnosticCollection.clear();

        if (!results || results.length === 0) {
            this.logger.debug('ResultsProvider', 'No diagnostics to display');
            return;
        }

        // Group diagnostics by file URI
        const diagnosticsMap = new Map<string, vscode.Diagnostic[]>();

        results.forEach(result => {
            if (!result.location || !result.location.file) {
                return;
            }

            const fileUri = vscode.Uri.file(result.location.file);
            const uriString = fileUri.toString();

            // Create a range for the diagnostic with bounds checking
            const startLine = Math.max(0, (result.location.startLine || 1) - 1);
            const startColumn = Math.max(0, (result.location.startColumn || 1) - 1);
            const endLine = Math.max(startLine, (result.location.endLine || result.location.startLine || 1) - 1);
            const endColumn = Math.max(startColumn + 1, (result.location.endColumn || result.location.startColumn || 1) - 1);

            const range = new vscode.Range(startLine, startColumn, endLine, endColumn);

            // Map severity to VS Code diagnostic severity
            const severity = this.mapToVSCodeSeverity(result.severity);

            // Create diagnostic with detailed message including last flow step info
            let flowInfo = '';
            if (result.flowSteps && result.flowSteps.length > 0) {
                const lastStep = result.flowSteps[result.flowSteps.length - 1];
                const sinkFile = lastStep.file.split('/').pop() || 'unknown';
                flowInfo = ` (${result.flowSteps.length} flow steps → ${sinkFile}:${lastStep.startLine})`;
            }
            const message = `[${result.severity?.toUpperCase()}] ${result.ruleId}: ${result.message}${flowInfo}`;
            const diagnostic = new vscode.Diagnostic(range, message, severity);
            
            // Add additional information to the diagnostic
            diagnostic.source = 'CodeQL Security Scanner';
            diagnostic.code = result.ruleId;

            // Add related information for flow steps
            if (result.flowSteps && result.flowSteps.length > 0) {
                const relatedInfo: vscode.DiagnosticRelatedInformation[] = [];
                
                // Add the sink (last step) first for visibility
                const lastStep = result.flowSteps[result.flowSteps.length - 1];
                const sinkRange = new vscode.Range(
                    Math.max(0, lastStep.startLine - 1),
                    Math.max(0, lastStep.startColumn - 1),
                    Math.max(0, lastStep.endLine - 1),
                    Math.max(0, lastStep.endColumn - 1)
                );
                relatedInfo.push(new vscode.DiagnosticRelatedInformation(
                    new vscode.Location(vscode.Uri.file(lastStep.file), sinkRange),
                    `🎯 Sink (Step ${result.flowSteps.length})${lastStep.message ? `: ${lastStep.message}` : ''}`
                ));

                // Add all flow steps
                result.flowSteps.forEach((step, index) => {
                    const stepRange = new vscode.Range(
                        Math.max(0, step.startLine - 1),
                        Math.max(0, step.startColumn - 1),
                        Math.max(0, step.endLine - 1),
                        Math.max(0, step.endColumn - 1)
                    );
                    const isSource = index === 0;
                    const isSink = index === result.flowSteps!.length - 1;
                    const stepLabel = isSource ? '🟢 Source' : isSink ? '🔴 Sink' : '🔵 Step';
                    
                    relatedInfo.push(new vscode.DiagnosticRelatedInformation(
                        new vscode.Location(vscode.Uri.file(step.file), stepRange),
                        `${stepLabel} ${index + 1}${step.message ? `: ${step.message}` : ''}`
                    ));
                });
                
                diagnostic.relatedInformation = relatedInfo;
            }

            // Get or create diagnostics array for this file
            let fileDiagnostics = diagnosticsMap.get(uriString);
            if (!fileDiagnostics) {
                fileDiagnostics = [];
                diagnosticsMap.set(uriString, fileDiagnostics);
            }

            fileDiagnostics.push(diagnostic);
        });

        // Set diagnostics for each file
        diagnosticsMap.forEach((diagnostics, uriString) => {
            this.diagnosticCollection.set(vscode.Uri.parse(uriString), diagnostics);
        });

        this.logger.logServiceCall('ResultsProvider', 'updateDiagnostics', 'completed', {
            fileCount: diagnosticsMap.size,
            diagnosticCount: Array.from(diagnosticsMap.values()).reduce((sum, diags) => sum + diags.length, 0)
        });
    }

    private mapToVSCodeSeverity(severity: string): vscode.DiagnosticSeverity {
        const originalSeverity = severity;
        let vscSeverity: vscode.DiagnosticSeverity;
        
        switch (severity?.toLowerCase()) {
            case 'critical':
            case 'high':
            case 'error':
                vscSeverity = vscode.DiagnosticSeverity.Error;
                break;
            case 'medium':
            case 'warning':
                vscSeverity = vscode.DiagnosticSeverity.Warning;
                break;
            case 'low':
            case 'info':
                vscSeverity = vscode.DiagnosticSeverity.Information;
                break;
            default:
                vscSeverity = vscode.DiagnosticSeverity.Warning;
                break;
        }
        
        this.logger.debug('ResultsProvider', 'Mapped severity', {
            from: originalSeverity,
            to: vscode.DiagnosticSeverity[vscSeverity]
        });
        
        return vscSeverity;
    }

    /**
     * Logs comprehensive statistics about the scan results
     * This provides a detailed breakdown of issues by language and severity
     */
    private logResultsStatistics(): void {
        if (!this.results || this.results.length === 0) {
            this.logger.info('ResultsStatistics', 'No scan results to analyze');
            return;
        }

        // Overall statistics
        const totalAlerts = this.results.length;
        
        // Group by language
        const languageGroups = this.groupByLanguage(this.results);
        const languageStats = Object.entries(languageGroups).map(([lang, results]) => ({
            language: lang,
            count: results.length,
            percentage: Math.round((results.length / totalAlerts) * 100)
        }));
        
        // Group by severity
        const severityCounts: { [severity: string]: number } = {};
        this.results.forEach(result => {
            const severity = result.severity || 'unknown';
            severityCounts[severity] = (severityCounts[severity] || 0) + 1;
        });
        
        // Count rules
        const ruleMap: { [ruleId: string]: number } = {};
        this.results.forEach(result => {
            const ruleId = result.ruleId || 'unknown';
            ruleMap[ruleId] = (ruleMap[ruleId] || 0) + 1;
        });
        
        // Find top rules
        const topRules = Object.entries(ruleMap)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 5)
            .map(([rule, count]) => ({ rule, count, percentage: Math.round((count / totalAlerts) * 100) }));
        
        // Count files with issues
        const fileMap: { [file: string]: number } = {};
        this.results.forEach(result => {
            if (result.location && result.location.file) {
                const fileName = result.location.file.split('/').pop() || 'unknown';
                fileMap[fileName] = (fileMap[fileName] || 0) + 1;
            }
        });
        
        // Find files with most issues
        const topFiles = Object.entries(fileMap)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 5)
            .map(([file, count]) => ({ file, count, percentage: Math.round((count / totalAlerts) * 100) }));
            
        // Count data flow results
        const dataFlowCount = this.results.filter(r => r.flowSteps && r.flowSteps.length > 0).length;
        const dataFlowPercentage = Math.round((dataFlowCount / totalAlerts) * 100);
        
        // Log the comprehensive statistics using the specialized method
        this.logger.logScanStatistics('ResultsProvider', {
            totalCount: totalAlerts,
            byLanguage: languageStats,
            bySeverity: severityCounts,
            topRules,
            topFiles,
            dataFlow: {
                count: dataFlowCount,
                percentage: dataFlowPercentage
            }
        });
    }

    dispose(): void {
        this.logger.info('ResultsProvider', 'Disposing ResultsProvider');
        this.diagnosticCollection.dispose();
    }
}

export class ResultItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly type: 'language' | 'severity' | 'result' | 'flowStep' | 'noResults',
        public readonly language?: string,
        public readonly results?: ScanResult[],
        public readonly result?: ScanResult,
        public readonly severity?: string,
        public readonly flowStep?: FlowStep,
        private readonly customTooltip?: string
    ) {
        super(label, collapsibleState);

        this.tooltip = this.getTooltip();
        this.description = this.getDescription();
        this.iconPath = this.getIcon();
        this.command = this.getCommand();
        this.contextValue = type;
    }

    private getTooltip(): string {
        if (this.customTooltip) {
            return this.customTooltip;
        }
        if (this.type === 'language') {
            return `${this.results?.length || 0} ${this.language} language issues`;
        } else if (this.type === 'severity') {
            return `${this.results?.length || 0} ${this.severity} severity issues in ${this.language}`;
        } else if (this.type === 'result' && this.result) {
            const flowInfo = this.result.flowSteps && this.result.flowSteps.length > 0 
                ? `\\nFlow steps: ${this.result.flowSteps.length}` 
                : '';
            return `${this.result.ruleId}: ${this.result.message}\\nFile: ${this.result.location.file}\\nLine: ${this.result.location.startLine}${flowInfo}`;
        } else if (this.type === 'flowStep' && this.flowStep) {
            return `Flow step ${this.flowStep.stepIndex + 1}\\nFile: ${this.flowStep.file}\\nLine: ${this.flowStep.startLine}${this.flowStep.message ? `\\nMessage: ${this.flowStep.message}` : ''}`;
        } else if (this.type === 'noResults') {
            return 'No security vulnerabilities were found in the scanned code';
        }
        return this.label;
    }

    private getDescription(): string {
        if (this.type === 'result' && this.result) {
            const flowCount = this.result.flowSteps?.length || 0;
            const baseDesc = `${this.result.location.file}:${this.result.location.startLine}`;
            return flowCount > 0 ? `${baseDesc} (${flowCount} steps)` : baseDesc;
        } else if (this.type === 'flowStep' && this.flowStep) {
            return `${this.flowStep.file}:${this.flowStep.startLine}`;
        }
        return '';
    }

    private getIcon(): vscode.ThemeIcon {
        if (this.type === 'language') {
            switch (this.language) {
            case 'javascript':
            case 'typescript':
                return new vscode.ThemeIcon('symbol-class', new vscode.ThemeColor('symbolIcon.classForeground'));
            case 'python':
                return new vscode.ThemeIcon('symbol-function', new vscode.ThemeColor('symbolIcon.functionForeground'));
            case 'java':
                return new vscode.ThemeIcon('symbol-interface', new vscode.ThemeColor('symbolIcon.interfaceForeground'));
            case 'csharp':
                return new vscode.ThemeIcon('symbol-namespace', new vscode.ThemeColor('symbolIcon.namespaceForeground'));
            case 'cpp':
            case 'c':
                return new vscode.ThemeIcon('symbol-struct', new vscode.ThemeColor('symbolIcon.structForeground'));
            case 'go':
                return new vscode.ThemeIcon('symbol-module', new vscode.ThemeColor('symbolIcon.moduleForeground'));
            case 'rust':
                return new vscode.ThemeIcon('symbol-package', new vscode.ThemeColor('symbolIcon.packageForeground'));
            case 'ruby':
                return new vscode.ThemeIcon('symbol-property', new vscode.ThemeColor('symbolIcon.propertyForeground'));
            case 'php':
                return new vscode.ThemeIcon('symbol-variable', new vscode.ThemeColor('symbolIcon.variableForeground'));
            case 'swift':
                return new vscode.ThemeIcon('symbol-key', new vscode.ThemeColor('symbolIcon.keyForeground'));
            case 'kotlin':
                return new vscode.ThemeIcon('symbol-constructor', new vscode.ThemeColor('symbolIcon.constructorForeground'));
            case 'scala':
                return new vscode.ThemeIcon('symbol-operator', new vscode.ThemeColor('symbolIcon.operatorForeground'));
            default:
                return new vscode.ThemeIcon('file-code');
            }
        } else if (this.type === 'severity') {
            switch (this.severity) {
                case 'critical':
                    return new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
                case 'error':
                case 'high':
                    return new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
                case 'warning':
                case 'medium':
                    return new vscode.ThemeIcon('warning', new vscode.ThemeColor('warningForeground'));
                case 'info':
                case 'low':
                    return new vscode.ThemeIcon('info', new vscode.ThemeColor('infoForeground'));
                default:
                    return new vscode.ThemeIcon('circle-outline');
            }
        } else if (this.type === 'result') {
            switch (this.result?.severity) {
                case 'critical':
                    return new vscode.ThemeIcon('bug', new vscode.ThemeColor('errorForeground'));
                case 'error':
                case 'high':
                    return new vscode.ThemeIcon('bug', new vscode.ThemeColor('errorForeground'));
                case 'warning':
                case 'medium':
                    return new vscode.ThemeIcon('warning', new vscode.ThemeColor('warningForeground'));
                case 'info':
                case 'low':
                    return new vscode.ThemeIcon('info', new vscode.ThemeColor('infoForeground'));
                default:
                    return new vscode.ThemeIcon('circle-filled');
            }
        } else if (this.type === 'flowStep') {
            // Use different icons based on step index to show flow progression
            if (this.flowStep?.stepIndex === 0) {
                return new vscode.ThemeIcon('play', new vscode.ThemeColor('charts.green')); // Source
            } else if (this.flowStep && this.result?.flowSteps && this.flowStep.stepIndex === this.result.flowSteps.length - 1) {
                return new vscode.ThemeIcon('target', new vscode.ThemeColor('charts.red')); // Sink
            } else {
                return new vscode.ThemeIcon('arrow-right', new vscode.ThemeColor('charts.blue')); // Intermediate step
            }
        } else if (this.type === 'noResults') {
            // Use different icons based on whether scan has been run
            if (this.label.includes('No security alerts found')) {
                return new vscode.ThemeIcon('check-all', new vscode.ThemeColor('charts.green'));
            } else {
                return new vscode.ThemeIcon('search', new vscode.ThemeColor('charts.blue'));
            }
        }
        return new vscode.ThemeIcon('circle-outline');
    }

    private getCommand(): vscode.Command | undefined {
        const logger = LoggerService.getInstance();
        
        if (this.type === 'result' && this.result) {
            return {
                command: 'codeql-scanner.resultSelected',
                title: 'Open File',
                arguments: [
                    this,
                    vscode.Uri.file(this.result.location.file),
                    {
                        selection: new vscode.Range(
                            this.result.location.startLine - 1,
                            this.result.location.startColumn - 1,
                            this.result.location.endLine - 1,
                            this.result.location.endColumn - 1
                        )
                    }
                ]
            };
        } else if (this.type === 'flowStep' && this.flowStep) {
            return {
                command: 'codeql-scanner.flowStepSelected',
                title: 'Open Flow Step',
                arguments: [
                    this,
                    vscode.Uri.file(this.flowStep.file),
                    {
                        selection: new vscode.Range(
                            this.flowStep.startLine - 1,
                            this.flowStep.startColumn - 1,
                            this.flowStep.endLine - 1,
                            this.flowStep.endColumn - 1
                        )
                    }
                ]
            };
        }
        return undefined;
    }
}
