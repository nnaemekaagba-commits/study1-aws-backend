/** Researcher IDs are provisioned by the server operator, never by signup data. */
export function isResearcherUserId(userId: string, configuredIds = process.env.RESEARCHER_USER_IDS): boolean {
  if (!userId || !configuredIds) return false;
  return configuredIds.split(',').map((id) => id.trim()).filter(Boolean).includes(userId);
}

export function validReplayStudentId(value: string): boolean {
  return /^[a-f0-9]{32}$/i.test(value);
}
