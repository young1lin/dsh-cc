/**
 * Slash-command token helpers shared by the composer (menu trigger and the
 * blue recognition token) and the transcript (blue leading token on user
 * rows). Pure string work over the session's cached command list.
 *
 * @module dsh-cc/client/command-mentions
 */

/** The structural slice of a command entry the matching needs. */
export interface CommandLike {
  name: string
  aliases?: string[]
}

/**
 * The draft's leading `/name` token, when the very first word is one.
 * @param text - the draft or message text.
 * @returns the token including its slash, or undefined when the text does not
 *   start with a slash word.
 */
export function commandToken(text: string): string | undefined {
  const match = /^(\S+)/.exec(text)
  if (match === null || !match[1].startsWith('/')) return undefined
  return match[1]
}

/**
 * Whether a leading token names a known command, by name or alias — the
 * recognition test behind the blue token.
 * @param token - the leading token including its slash.
 * @param commands - the session's cached command list.
 * @returns the matched command, or undefined.
 */
export function matchCommand(token: string, commands: readonly CommandLike[]): CommandLike | undefined {
  const bare = token.slice(1).toLowerCase()
  if (bare === '') return undefined
  return commands.find(command =>
    command.name.toLowerCase() === bare
    || command.aliases?.some(alias => alias.toLowerCase() === bare))
}
