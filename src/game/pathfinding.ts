import * as Matter from "matter-js";
import { BAND_EPSILON, BAND_WALL_THICKNESS, CONTACT_EPSILON } from "./constants";
import { getTetrominoParts, isTetrominoBody } from "./pieces";
import type { PathNode, StageSize } from "./types";

export function findLeftRightPath(
  world: Matter.World,
  viewport: StageSize,
  bandHalfWidth: number,
  marginSlack: number,
): { pathNodes: PathNode[]; leftX: number; rightX: number } | null {
  const center = viewport.width / 2;
  const leftX = center - bandHalfWidth;
  const rightX = center + bandHalfWidth;
  const nodes = gatherConductiveNodes(world, leftX, rightX);
  // Pieces rest against solid band walls centered on leftX/rightX, so they can never get closer than half a wall.
  const slack = Math.max(marginSlack, BAND_WALL_THICKNESS / 2 + BAND_EPSILON);

  if (nodes.length === 0) {
    return null;
  }

  const graph = buildGraph(nodes);
  const startIds = nodes.filter((node) => node.bounds.min.x <= leftX + slack).map((node) => node.id);
  const goalIds = new Set(nodes.filter((node) => node.bounds.max.x >= rightX - slack).map((node) => node.id));

  if (startIds.length === 0 || goalIds.size === 0) {
    return null;
  }

  const queue = [...startIds];
  const visited = new Set(startIds);
  const previous = new Map<number, number | null>(startIds.map((id) => [id, null]));
  let goal: number | null = null;

  while (queue.length > 0) {
    const nodeId = queue.shift();

    if (nodeId === undefined) {
      break;
    }

    if (goalIds.has(nodeId)) {
      goal = nodeId;
      break;
    }

    for (const neighborId of graph[nodeId]) {
      if (visited.has(neighborId)) {
        continue;
      }

      visited.add(neighborId);
      previous.set(neighborId, nodeId);
      queue.push(neighborId);
    }
  }

  if (goal === null) {
    return null;
  }

  const pathIds: number[] = [];

  for (let current: number | null = goal; current !== null; current = previous.get(current) ?? null) {
    pathIds.push(current);
  }

  pathIds.reverse();

  return {
    pathNodes: pathIds.map((id) => nodes[id]),
    leftX,
    rightX,
  };
}

export function jitteredPolyline(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  if (points.length < 2) {
    return points;
  }

  const output = [points[0]];

  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    const normalX = -dy / length;
    const normalY = dx / length;
    const cuts = 1 + Math.floor(Math.random() * 2);

    for (let cut = 1; cut <= cuts; cut += 1) {
      const t = cut / (cuts + 1);
      const pointX = start.x + dx * t;
      const pointY = start.y + dy * t;
      const amplitude = 6 + Math.random() * 8;

      output.push({
        x: pointX + normalX * (Math.random() * 2 - 1) * amplitude,
        y: pointY + normalY * (Math.random() * 2 - 1) * amplitude,
      });
    }

    output.push(end);
  }

  return output;
}

function gatherConductiveNodes(world: Matter.World, leftX: number, rightX: number): PathNode[] {
  const nodes: PathNode[] = [];

  for (const body of Matter.Composite.allBodies(world)) {
    if (!isTetrominoBody(body) || body.plugin.isInsulating) {
      continue;
    }

    for (const part of getTetrominoParts(body)) {
      const bounds = part.bounds;

      if (bounds.max.x < leftX - BAND_EPSILON || bounds.min.x > rightX + BAND_EPSILON) {
        continue;
      }

      nodes.push({
        id: nodes.length,
        part,
        parent: body,
        cx: (bounds.min.x + bounds.max.x) / 2,
        cy: (bounds.min.y + bounds.max.y) / 2,
        bounds,
      });
    }
  }

  return nodes;
}

function buildGraph(nodes: PathNode[]): number[][] {
  const graph = Array.from({ length: nodes.length }, () => [] as number[]);

  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    const leftBounds = nodes[leftIndex].bounds;

    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const rightBounds = nodes[rightIndex].bounds;
      const overlapsX = !(leftBounds.max.x < rightBounds.min.x - CONTACT_EPSILON || rightBounds.max.x < leftBounds.min.x - CONTACT_EPSILON);
      const overlapsY = !(leftBounds.max.y < rightBounds.min.y - CONTACT_EPSILON || rightBounds.max.y < leftBounds.min.y - CONTACT_EPSILON);

      if (!overlapsX || !overlapsY) {
        continue;
      }

      graph[leftIndex].push(rightIndex);
      graph[rightIndex].push(leftIndex);
    }
  }

  return graph;
}
