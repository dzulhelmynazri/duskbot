// Security: the private folder, inside a bot's own workspace or Local VM workspace, where a secret the person gave for the
// bot's commands lives for a day. Nothing that syncs, backs up, moves, links, attaches, publishes, uploads or snapshots
// workspace files may carry anything under it.
export const SECRET_FOLDER = ".madanibot-secrets";

export const SECRET_FILE_REFUSAL =
  "That file holds a secret the person gave for your own commands only: it cannot be opened from chat, attached, published, uploaded or read by a helper.";

export function inSecretFolder(path: string, platform: NodeJS.Platform = process.platform): boolean {
  // macOS and Windows volumes match names without case, so a differently cased path still reaches this folder.
  const caseInsensitive = platform === "darwin" || platform === "win32";
  return path.split(/[\\/]/).some((segment) => caseInsensitive ? segment.toLowerCase() === SECRET_FOLDER : segment === SECRET_FOLDER);
}
