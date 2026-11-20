export function releaseActions(flags = {}) {
  const publish = flags.verifyOnly !== true && flags.dryRun !== true;
  return { publish, push: publish };
}
