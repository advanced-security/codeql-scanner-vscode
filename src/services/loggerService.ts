import * as vscode from 'vscode';

export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3
}

export interface LogEntry {
    timestamp: string;
    level: LogLevel;
    source: string;
    message: string;
    data?: any;
}

export class LoggerService {
    private static instance: LoggerService;
    private outputChannel: vscode.OutputChannel;
    private logLevel: LogLevel;
    private logs: LogEntry[] = [];

    private constructor() {
        this.outputChannel = vscode.window.createOutputChannel('CodeQL Scanner');
        this.logLevel = this.getConfiguredLogLevel();
        
        // Watch for configuration changes
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('codeql-scanner.logging.level')) {
                this.logLevel = this.getConfiguredLogLevel();
            }
        });
    }

    public static getInstance(): LoggerService {
        if (!LoggerService.instance) {
            LoggerService.instance = new LoggerService();
        }
        return LoggerService.instance;
    }

    private getConfiguredLogLevel(): LogLevel {
        const config = vscode.workspace.getConfiguration('codeql-scanner');
        const level = config.get<string>('logging.level', 'INFO').toUpperCase();
        
        switch (level) {
            case 'DEBUG': return LogLevel.DEBUG;
            case 'INFO': return LogLevel.INFO;
            case 'WARN': return LogLevel.WARN;
            case 'ERROR': return LogLevel.ERROR;
            default: return LogLevel.INFO;
        }
    }

    private shouldLog(level: LogLevel): boolean {
        return level >= this.logLevel;
    }

    private formatMessage(level: LogLevel, source: string, message: string, data?: any): string {
        const timestamp = new Date().toISOString();
        const levelStr = LogLevel[level].padEnd(5);
        const sourceStr = source.padEnd(15);
        
        let formatted = `[${timestamp}] [${levelStr}] [${sourceStr}] ${message}`;
        
        if (data !== undefined) {
            if (typeof data === 'object') {
                formatted += `\n${JSON.stringify(data, null, 2)}`;
            } else {
                formatted += ` | Data: ${data}`;
            }
        }
        
        return formatted;
    }

    private log(level: LogLevel, source: string, message: string, data?: any): void {
        if (!this.shouldLog(level)) {
            return;
        }

        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level,
            source,
            message,
            data
        };

        this.logs.push(entry);
        
        // Keep only last 1000 log entries to prevent memory issues
        if (this.logs.length > 1000) {
            this.logs = this.logs.slice(-1000);
        }

        const formatted = this.formatMessage(level, source, message, data);
        this.outputChannel.appendLine(formatted);

        // Also log to console for development
        const config = vscode.workspace.getConfiguration('codeql-scanner');
        const enableConsoleLogging = config.get<boolean>('logging.enableConsole', false);
        
        if (enableConsoleLogging) {
            switch (level) {
                case LogLevel.DEBUG:
                case LogLevel.INFO:
                    console.log(`[CodeQL Scanner] ${formatted}`);
                    break;
                case LogLevel.WARN:
                    console.warn(`[CodeQL Scanner] ${formatted}`);
                    break;
                case LogLevel.ERROR:
                    console.error(`[CodeQL Scanner] ${formatted}`);
                    break;
            }
        }
    }

    public debug(source: string, message: string, data?: any): void {
        this.log(LogLevel.DEBUG, source, message, data);
    }

    public info(source: string, message: string, data?: any): void {
        this.log(LogLevel.INFO, source, message, data);
    }

    public warn(source: string, message: string, data?: any): void {
        this.log(LogLevel.WARN, source, message, data);
    }

    public error(source: string, message: string, data?: any): void {
        this.log(LogLevel.ERROR, source, message, data);
    }

    public getLogs(): LogEntry[] {
        return [...this.logs];
    }

    public clearLogs(): void {
        this.logs = [];
        this.outputChannel.clear();
    }

    public show(): void {
        this.outputChannel.show();
    }

    public dispose(): void {
        this.outputChannel.dispose();
    }

    // Utility methods for common logging scenarios
    public logCommand(command: string, status: 'started' | 'completed' | 'failed', error?: any): void {
        switch (status) {
            case 'started':
                this.info('Extension', `Command started: ${command}`);
                break;
            case 'completed':
                this.info('Extension', `Command completed: ${command}`);
                break;
            case 'failed':
                this.error('Extension', `Command failed: ${command}`, error);
                break;
        }
    }

    public logServiceCall(service: string, method: string, status: 'started' | 'completed' | 'failed', data?: any): void {
        const message = `${service}.${method}`;
        switch (status) {
            case 'started':
                this.debug(service, `Starting ${method}`, data);
                break;
            case 'completed':
                this.debug(service, `Completed ${method}`, data);
                break;
            case 'failed':
                this.error(service, `Failed ${method}`, data);
                break;
        }
    }

    public logProgress(source: string, message: string, increment?: number): void {
        const data = increment !== undefined ? { increment } : undefined;
        this.debug(source, `Progress: ${message}`, data);
    }

    public logConfiguration(source: string, config: any): void {
        this.debug(source, 'Configuration loaded', config);
    }

    public logGitHubAPI(endpoint: string, status: 'request' | 'response' | 'error', data?: any): void {
        switch (status) {
            case 'request':
                this.debug('GitHub API', `Request to ${endpoint}`, data);
                break;
            case 'response':
                this.debug('GitHub API', `Response from ${endpoint}`, data);
                break;
            case 'error':
                this.error('GitHub API', `Error from ${endpoint}`, data);
                break;
        }
    }

    public logCodeQLCLI(command: string, status: 'started' | 'completed' | 'failed', output?: string, error?: string): void {
        switch (status) {
            case 'started':
                this.debug('CodeQL CLI', `Executing: ${command}`);
                break;
            case 'completed':
                this.debug('CodeQL CLI', `Completed: ${command}`, { output });
                break;
            case 'failed':
                this.error('CodeQL CLI', `Failed: ${command}`, { error });
                break;
        }
    }
    
    public logUserInteraction(interactionType: string, item: string, data?: any): void {
        this.info('UserInteraction', `${interactionType}: ${item}`, data);
    }

    /**
     * Log statistics about scan results in a structured way
     * @param source Source of the statistics (e.g., 'ResultsProvider')
     * @param results Statistics about the scan results
     */
    public logScanStatistics(source: string, results: {
        totalCount: number;
        byLanguage?: { language: string; count: number; percentage: number }[];
        bySeverity?: { [severity: string]: number };
        topRules?: { rule: string; count: number; percentage: number }[];
        topFiles?: { file: string; count: number; percentage: number }[];
        dataFlow?: { count: number; percentage: number };
    }): void {
        this.info(source, `Scan Results Statistics (${results.totalCount} alerts)`, results);
    }
}
