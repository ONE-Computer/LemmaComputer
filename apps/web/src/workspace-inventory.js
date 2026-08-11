// Keep established workspace cards in place when a status refresh arrives in
// a different order. New workspaces retain the server's creation order.
export const reconcileWorkspaceInventory = (current, incoming) => {
  const nextById = new Map(incoming.map((workspace) => [workspace.id, workspace]));
  const currentIds = new Set(current.map((workspace) => workspace.id));

  return [
    ...current.map((workspace) => nextById.get(workspace.id)).filter(Boolean),
    ...incoming.filter((workspace) => !currentIds.has(workspace.id)),
  ];
};

export const replaceWorkspaceInInventory = (current, next) => {
  const index = current.findIndex((workspace) => workspace.id === next.id);
  if (index === -1) return [next, ...current];
  return current.map((workspace) => workspace.id === next.id ? next : workspace);
};
