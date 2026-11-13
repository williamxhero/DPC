import type { ActionDescriptor, PlanSnapshot, Profile } from "./types.js";

export interface ConformanceCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly reason?: string;
}

export interface ProfileConformanceReport {
  readonly profileName: string;
  readonly passed: boolean;
  readonly checks: readonly ConformanceCheck[];
}

/**
 * Shared profile contract checks. A profile contributes descriptors and domain
 * interpretation only; lifecycle and safety remain in DpcCore.
 */
export function inspectProfileConformance(
  profile: Profile,
  plan: PlanSnapshot,
  profileName = "profile",
): ProfileConformanceReport {
  const checks: ConformanceCheck[] = [];
  let descriptors: readonly ActionDescriptor[] = [];
  try {
    descriptors = profile.getActionDescriptors(plan);
    checks.push({ name: "descriptor-read", passed: true });
  } catch (error) {
    checks.push({ name: "descriptor-read", passed: false, reason: String(error) });
  }

  const ids = new Set<string>();
  for (const descriptor of descriptors) {
    const unique = !ids.has(descriptor.actionId);
    ids.add(descriptor.actionId);
    checks.push({
      name: `unique-action:${descriptor.actionId}`,
      passed: unique,
      reason: unique ? undefined : "duplicate action identity",
    });
    checks.push({
      name: `authorization:${descriptor.actionId}`,
      passed: descriptor.authorization.reference.length > 0,
      reason: "action authorization reference is required",
    });
    checks.push({
      name: `dependencies:${descriptor.actionId}`,
      passed: descriptor.dependencies.every((dependency) => descriptors.some((candidate) => candidate.actionId === dependency)),
      reason: "dependency must reference a descriptor in the same profile plan",
    });
  }

  return {
    profileName,
    passed: checks.every((check) => check.passed),
    checks,
  };
}
