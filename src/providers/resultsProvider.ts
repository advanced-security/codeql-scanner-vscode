import * as vscode from 'vscode';
import { ScanResult, FlowStep } from '../services/codeqlService';

export class ResultsProvider implements vscode.TreeDataProvider<ResultItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ResultItem | undefined | null | void> = new vscode.EventEmitter<ResultItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ResultItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private results: ScanResult[] = [];
    private diagnosticCollection: vscode.DiagnosticCollection;

    constructor() {
        // Create a diagnostic collection for CodeQL security issues
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('codeql-security');
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    setResults(results: ScanResult[]): void {
        this.results = results;
        this.updateDiagnostics(results);
        this.refresh();
    }

    getResults(): ScanResult[] {
        return this.results;
    }

    clearResults(): void {
        this.results = [];
        this.diagnosticCollection.clear();
        this.refresh();
    }

    getTreeItem(element: ResultItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ResultItem): Thenable<ResultItem[]> {
        if (!element) {
            // Root level - group by language
            const groups = this.groupByLanguage(this.results);
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
            const severityGroups = this.groupBySeverity(element.results!);
            const sortedSeverities = this.sortSeverityGroups(severityGroups);
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
        return results.reduce((groups, result) => {
            const language = result.language || 'unknown';
            if (!groups[language]) {
                groups[language] = [];
            }
            groups[language].push(result);
            return groups;
        }, {} as { [language: string]: ScanResult[] });
    }

    private groupBySeverity(results: ScanResult[]): { [severity: string]: ScanResult[] } {
        return results.reduce((groups, result) => {
            const severity = result.severity || 'unknown';
            if (!groups[severity]) {
                groups[severity] = [];
            }
            groups[severity].push(result);
            return groups;
        }, {} as { [severity: string]: ScanResult[] });
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
        const severityOrder = ['critical', 'high', 'error', 'medium', 'warning', 'low', 'info', 'unknown'];
        
        return Object.entries(severityGroups).sort(([a], [b]) => {
            const aIndex = severityOrder.indexOf(a);
            const bIndex = severityOrder.indexOf(b);
            
            // If severity not found in order, put it at the end
            if (aIndex === -1 && bIndex === -1) return a.localeCompare(b);
            if (aIndex === -1) return 1;
            if (bIndex === -1) return -1;
            
            return aIndex - bIndex;
        });
    }

    private updateDiagnostics(results: ScanResult[]): void {
        // Clear existing diagnostics
        this.diagnosticCollection.clear();

        if (!results || results.length === 0) {
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

            // Create diagnostic with detailed message
            const flowInfo = result.flowSteps && result.flowSteps.length > 0 
                ? ` (${result.flowSteps.length} flow steps)` 
                : '';
            const message = `[${result.severity?.toUpperCase()}] ${result.ruleId}: ${result.message}${flowInfo}`;
            const diagnostic = new vscode.Diagnostic(range, message, severity);
            
            // Add additional information to the diagnostic
            diagnostic.source = 'CodeQL Security Scanner';
            diagnostic.code = result.ruleId;

            // Add related information for flow steps
            if (result.flowSteps && result.flowSteps.length > 0) {
                diagnostic.relatedInformation = result.flowSteps.map((step, index) => {
                    const stepRange = new vscode.Range(
                        Math.max(0, step.startLine - 1),
                        Math.max(0, step.startColumn - 1),
                        Math.max(0, step.endLine - 1),
                        Math.max(0, step.endColumn - 1)
                    );
                    return new vscode.DiagnosticRelatedInformation(
                        new vscode.Location(vscode.Uri.file(step.file), stepRange),
                        `Flow step ${index + 1}${step.message ? `: ${step.message}` : ''}`
                    );
                });
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
    }

    private mapToVSCodeSeverity(severity: string): vscode.DiagnosticSeverity {
        switch (severity?.toLowerCase()) {
            case 'critical':
            case 'high':
            case 'error':
                return vscode.DiagnosticSeverity.Error;
            case 'medium':
            case 'warning':
                return vscode.DiagnosticSeverity.Warning;
            case 'low':
            case 'info':
                return vscode.DiagnosticSeverity.Information;
            default:
                return vscode.DiagnosticSeverity.Warning;
        }
    }

    dispose(): void {
        this.diagnosticCollection.dispose();
    }
}

export class ResultItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly type: 'language' | 'severity' | 'result' | 'flowStep',
        public readonly language?: string,
        public readonly results?: ScanResult[],
        public readonly result?: ScanResult,
        public readonly severity?: string,
        public readonly flowStep?: FlowStep
    ) {
        super(label, collapsibleState);

        this.tooltip = this.getTooltip();
        this.description = this.getDescription();
        this.iconPath = this.getIcon();
        this.command = this.getCommand();
        this.contextValue = type;
    }

    private getTooltip(): string {
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
                    return new vscode.ThemeIcon('symbol-class', new vscode.ThemeColor('symbolIcon.classForeground'));
                case 'python':
                    return new vscode.ThemeIcon('symbol-function', new vscode.ThemeColor('symbolIcon.functionForeground'));
                case 'java':
                    return new vscode.ThemeIcon('symbol-interface', new vscode.ThemeColor('symbolIcon.interfaceForeground'));
                case 'csharp':
                    return new vscode.ThemeIcon('symbol-namespace', new vscode.ThemeColor('symbolIcon.namespaceForeground'));
                case 'cpp':
                    return new vscode.ThemeIcon('symbol-struct', new vscode.ThemeColor('symbolIcon.structForeground'));
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
        }
        return new vscode.ThemeIcon('circle-outline');
    }

    private getCommand(): vscode.Command | undefined {
        if (this.type === 'result' && this.result) {
            return {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [
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
                command: 'vscode.open',
                title: 'Open Flow Step',
                arguments: [
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
