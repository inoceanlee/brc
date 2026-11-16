import { COMMAND_SPECS } from './parser.js';

export type CompletionShell = 'powershell' | 'bash' | 'zsh' | 'fish';

export function completionScript(shell: CompletionShell): string {
  const names = COMMAND_SPECS.map((item) => item.name);
  const joined = names.join(' ');
  switch (shell) {
    case 'powershell':
      return [
        "Register-ArgumentCompleter -Native -CommandName brc -ScriptBlock {",
        "  param($wordToComplete, $commandAst, $cursorPosition)",
        "  $commands = @(" + names.map((name) => "'" + name + "'").join(', ') + ")",
        "  $commands | Where-Object { $_ -like ($wordToComplete + '*') } | ForEach-Object {",
        "    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)",
        "  }",
        "}",
      ].join('\n');
    case 'bash':
      return "complete -W '" + joined + "' brc";
    case 'zsh':
      return [
        '_brc() {',
        "  _arguments '1:command:(" + joined + ")'",
        '}',
        'compdef _brc brc',
      ].join('\n');
    case 'fish':
      return names.map((name) => "complete -c brc -f -a '" + name + "'").join('\n');
  }
}
