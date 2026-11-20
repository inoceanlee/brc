import { GLOBAL_FLAGS } from './options.js';
import { COMMAND_SPECS } from './parser.js';

export type CompletionShell = 'powershell' | 'bash' | 'zsh' | 'fish';

const subcommands = COMMAND_SPECS.map((item) => item.name);
const flagTokens = GLOBAL_FLAGS.flatMap((flag) => [flag.long.split(' ')[0], ...(flag.short ? [flag.short] : [])]);
const completionTokens = [...subcommands, ...flagTokens];

function quote(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

export function completionScript(shell: CompletionShell): string {
  switch (shell) {
    case 'powershell':
      return [
        'Register-ArgumentCompleter -Native -CommandName brc -ScriptBlock {',
        '  param($wordToComplete, $commandAst, $cursorPosition)',
        '  $tokens = @(' + completionTokens.map(quote).join(', ') + ')',
        "  $tokens | Where-Object { $_ -like ($wordToComplete + '*') } | ForEach-Object {",
        "    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)",
        '  }',
        '}',
      ].join('\n');
    case 'bash':
      return 'complete -W ' + quote(completionTokens.join(' ')) + ' brc';
    case 'zsh':
      return [
        '_brc() {',
        "  _arguments '1:command:(" + subcommands.join(' ') + ")' '*::flags:(" + flagTokens.join(' ') + ")'",
        '}',
        'compdef _brc brc',
      ].join('\n');
    case 'fish':
      return [
        ...subcommands.map((name) => "complete -c brc -f -a '" + name + "'"),
        ...flagTokens.map((flag) => (flag.startsWith('--')
          ? "complete -c brc -l " + flag.slice(2)
          : "complete -c brc -s " + flag.slice(1)) + " -a '" + flag + "'"),
      ].join('\n');
  }
}
