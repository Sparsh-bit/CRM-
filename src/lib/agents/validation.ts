/**
 * Runtime validation for the AI Workforce's named-value fields. TypeScript
 * catches an invalid literal from code inside this repo; it catches nothing
 * from a value that arrives as a plain string — a form field, an API body, a
 * command-center prompt. Autonomy level and task status gate whether an agent
 * is allowed to act unattended, so those two (and priority) are validated
 * here rather than left to whatever UI happens to constrain them later.
 */
import { AutonomyLevel, TaskStatus } from '@/generated/prisma/enums';

export function parseAutonomyLevel(value: string): AutonomyLevel {
  if (!(Object.values(AutonomyLevel) as string[]).includes(value)) {
    throw new Error(`Invalid autonomy level: "${value}". Must be one of ${Object.values(AutonomyLevel).join(', ')}.`);
  }
  return value as AutonomyLevel;
}

export function parseTaskStatus(value: string): TaskStatus {
  if (!(Object.values(TaskStatus) as string[]).includes(value)) {
    throw new Error(`Invalid task status: "${value}". Must be one of ${Object.values(TaskStatus).join(', ')}.`);
  }
  return value as TaskStatus;
}

/** 0=low 1=normal 2=high 3=urgent — see the comment on AgentTask.priority in schema.prisma. */
export function parsePriority(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 3) {
    throw new Error(`Invalid priority: ${value}. Must be an integer 0-3 (0=low, 1=normal, 2=high, 3=urgent).`);
  }
  return value;
}
