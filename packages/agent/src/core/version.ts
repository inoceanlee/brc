/** Runtime compatibility metadata follows the installed BRC package release. */
export let VERSION = 'unknown';

export function setProductVersion(value: string | undefined): void {
  VERSION = value ?? 'unknown';
}
