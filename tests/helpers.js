export const id = (value) => value;

export function makeDescriptor(actionId, dependencies = [], prefix = "test") {
  return {
    actionId: id(actionId),
    actionType: `${prefix}.${actionId}`,
    target: { name: actionId },
    metrics: ["completed"],
    authorization: { reference: `${prefix}-test`, scopes: ["execute"] },
    stopConditions: ["done"],
    waitConditions: [],
    dependencies: dependencies.map(id),
  };
}
