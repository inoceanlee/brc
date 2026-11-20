import path from 'path';
import type { AgentConfigManager } from '../storage/config-manager.js';

export class CommandManager {
    constructor(
        private readonly configManager: Pick<AgentConfigManager, 'getConfig'>,
        private readonly capture: (event: string, properties?: unknown) => Promise<void>
    ) {}


    getBaseCommand(command: string) {
        return command.split(' ')[0].toLowerCase().trim();
    }

    extractCommands(commandString: string): string[] {
        try {
            
            commandString = commandString.trim();

            
            const separators = [';', '&&', '||', '|', '&'];

            
            const commands: string[] = [];

            
            let inQuote = false;
            let quoteChar = '';
            let currentCmd = '';
            let escaped = false;

            for (let i = 0; i < commandString.length; i++) {
                const char = commandString[i];

                
                if (char === '\\' && !escaped) {
                    escaped = true;
                    currentCmd += char;
                    continue;
                }

                
                if (escaped) {
                    escaped = false;
                    currentCmd += char;
                    continue;
                }

                
                if ((char === '"' || char === "'") && !inQuote) {
                    inQuote = true;
                    quoteChar = char;
                    currentCmd += char;
                    continue;
                } else if (char === quoteChar && inQuote) {
                    inQuote = false;
                    quoteChar = '';
                    currentCmd += char;
                    continue;
                }

                
                if (char === '$' && i + 1 < commandString.length && commandString[i + 1] === '(') {
                    const startIndex = i;
                    let openParens = 1;
                    let j = i + 2; 
                    while (j < commandString.length && openParens > 0) {
                        if (commandString[j] === '(') openParens++;
                        if (commandString[j] === ')') openParens--;
                        j++;
                    }
                    if (j <= commandString.length && openParens === 0) {
                        const subContent = commandString.substring(i + 2, j - 1);
                        const subCommands = this.extractCommands(subContent);
                        commands.push(...subCommands);
                        i = j - 1;
                        if (!inQuote) {
                            continue;
                        } else {
                            currentCmd += commandString.substring(startIndex, j);
                            continue;
                        }
                    }
                }

                
                if (char === '`') {
                    const startIndex = i;
                    let j = i + 1;
                    while (j < commandString.length && commandString[j] !== '`') {
                        j++;
                    }
                    if (j < commandString.length) {
                        const subContent = commandString.substring(i + 1, j);
                        const subCommands = this.extractCommands(subContent);
                        commands.push(...subCommands);
                        i = j;
                        if (!inQuote) {
                            continue;
                        } else {
                            currentCmd += commandString.substring(startIndex, j + 1);
                            continue;
                        }
                    }
                }

                
                if (inQuote) {
                    currentCmd += char;
                    continue;
                }

                
                if (char === '(') {
                    
                    let openParens = 1;
                    let j = i + 1;
                    while (j < commandString.length && openParens > 0) {
                        if (commandString[j] === '(') openParens++;
                        if (commandString[j] === ')') openParens--;
                        j++;
                    }

                    
                    if (j <= commandString.length && openParens === 0) {
                        const subshellContent = commandString.substring(i + 1, j - 1);
                        
                        const subCommands = this.extractCommands(subshellContent);
                        commands.push(...subCommands);

                        
                        i = j - 1;
                        continue;
                    }
                }

                
                let isSeparator = false;
                for (const separator of separators) {
                    if (commandString.startsWith(separator, i)) {
                        
                        if (currentCmd.trim()) {
                            const baseCommand = this.extractBaseCommand(currentCmd.trim());
                            if (baseCommand) commands.push(baseCommand);
                        }

                        
                        i += separator.length - 1;
                        currentCmd = '';
                        isSeparator = true;
                        break;
                    }
                }

                if (!isSeparator) {
                    currentCmd += char;
                }
            }

            
            if (currentCmd.trim()) {
                const baseCommand = this.extractBaseCommand(currentCmd.trim());
                if (baseCommand) commands.push(baseCommand);
            }

            
            return [...new Set(commands)];
        } catch (error) {
            
            this.capture('server_request_error', {
                error: 'Error extracting commands'
            });
            const baseCmd = this.extractBaseCommand(commandString);
            return baseCmd ? [baseCmd] : [];
        }
    }

    
    extractBaseCommand(commandStr: string): string | null {
        try {
            
            const withoutEnvVars = commandStr.replace(/\w+=\S+\s*/g, '').trim();

            
            if (!withoutEnvVars) return null;

            
            const tokens = withoutEnvVars.split(/\s+/);
            let firstToken = null;

            
            for (let i = 0; i < tokens.length; i++) {
                const token = tokens[i];
                
                
                if (token.startsWith('$') && !token.startsWith('$(')) {
                    continue;
                }
                
                
                if (token[0] === '(') {
                    continue;
                }
                
                firstToken = token;
                break;
            }

            
            if (!firstToken) {
                return null;
            }

            
            if (firstToken.startsWith('$(') && firstToken.endsWith(')')) {
                const inner = firstToken.slice(2, -1).trim();
                if (inner) {
                    const innerTokens = inner.split(/\s+/);
                    return path.basename(innerTokens[0]).toLowerCase();
                }
                return null;
            }

            
            const baseName = path.basename(firstToken);
            return baseName.toLowerCase();
        } catch (error) {
            this.capture('Error extracting base command');
            return null;
        }
    }

    async validateCommand(command: string): Promise<boolean> {
        try {
            
            const config = await this.configManager.getConfig();
            const blockedCommands = config.blockedCommands || [];
            
            
            const allCommands = this.extractCommands(command);
            
            
            if (allCommands.length === 0) {
                const baseCommand = this.getBaseCommand(command);
                return !blockedCommands.includes(baseCommand);
            }
            
            
            for (const cmd of allCommands) {
                if (blockedCommands.includes(cmd)) {
                    return false; 
                }
            }
            
            
            return true;
        } catch (error) {
            console.error('Error validating command:', error);
            this.capture('server_validate_command_error', {
                error: error instanceof Error ? error.message : String(error)
            });
            
            
            return false;
        }
    }
}
