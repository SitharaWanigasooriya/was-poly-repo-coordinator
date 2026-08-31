'use strict';
/**
 * Dependency ordering for members.
 *
 * `dependsOn` in poly.json names the members a given member is built on top of.
 * When several pointers move together, the ones with no unmet dependencies have
 * to land first, so a build of the superproject at any intermediate commit
 * still resolves. This is Kahn's algorithm, stable: members that are free to go
 * keep their manifest order.
 */

/**
 * @param {{name: string, dependsOn?: string[]}[]} members
 * @returns {{ order: object[], unknownDeps: {member: string, missing: string[]}[] }}
 * @throws  Error (userFacing) when dependsOn contains a cycle
 */
function topoSort(members) {
  const byName = new Map(members.map(m => [m.name, m]));
  const names = new Set(byName.keys());

  const unknownDeps = [];
  const deps = new Map(); // name -> Set of in-scope dependency names
  for (const m of members) {
    const wanted = m.dependsOn || [];
    const missing = wanted.filter(d => !names.has(d));
    if (missing.length) unknownDeps.push({ member: m.name, missing });
    deps.set(m.name, new Set(wanted.filter(d => names.has(d))));
  }

  const order = [];
  const placed = new Set();

  // Repeatedly take, in manifest order, every member whose deps are all placed.
  let progressed = true;
  while (placed.size < members.length && progressed) {
    progressed = false;
    for (const m of members) {
      if (placed.has(m.name)) continue;
      const ready = [...deps.get(m.name)].every(d => placed.has(d));
      if (ready) {
        order.push(m);
        placed.add(m.name);
        progressed = true;
      }
    }
  }

  if (placed.size < members.length) {
    const stuck = members.filter(m => !placed.has(m.name)).map(m => m.name);
    const err = new Error(
      `dependsOn has a cycle among: ${stuck.join(', ')}\n` +
      `  Break the loop in poly.json before landing these together.`
    );
    err.userFacing = true;
    throw err;
  }

  return { order, unknownDeps };
}

module.exports = { topoSort };
