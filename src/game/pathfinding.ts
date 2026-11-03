import * as Matter from "matter-js";
import { AIR_BREAKDOWN_KV_PER_PX, AIR_GAP_WEIGHT, BAND_EPSILON, BAND_WALL_THICKNESS, CONTACT_EPSILON } from "./constants";
import { getTetrominoParts, isTetrominoBody } from "./pieces";
import type { AirArc, PathNode, StageSize } from "./types";

/**
 * Finds the discharge path between the left and right band walls.
 *
 * Model: the applied voltage sits across the series of air gaps along the path (metal drops ~0 V), so the
 * path can break down only if its total air gap is at most voltage / breakdown field (air: ~3 kV/mm). Among
 * candidates the arc takes the path with the least total air, then the shortest metal run.
 */
export function findLeftRightPath(
  world: Matter.World,
  viewport: StageSize,
  bandHalfWidth: number,
  voltageKv: number,
): { pathNodes: PathNode[]; leftX: number; rightX: number; totalGap: number; arcs: AirArc[] } | null {
  const center = viewport.width / 2;
  const leftX = center - bandHalfWidth;
  const rightX = center + bandHalfWidth;
  const maxGap = voltageKv / AIR_BREAKDOWN_KV_PER_PX;
  // Electrodes are the band walls' inner faces.
  const leftFace = leftX + BAND_WALL_THICKNESS / 2;
  const rightFace = rightX - BAND_WALL_THICKNESS / 2;
  const nodes = gatherConductiveNodes(world, leftX, rightX);

  if (nodes.length === 0) {
    return null;
  }

  const graph = buildGraph(nodes, maxGap);
  const extent = nodes.map((node) => {
    const xs = node.part.vertices.map((vertex) => vertex.x);
    return { min: Math.min(...xs), max: Math.max(...xs) };
  });
  const leftGap = (id: number): number => Math.max(0, extent[id].min - leftFace);
  const rightGap = (id: number): number => Math.max(0, rightFace - extent[id].max);

  const cost = new Array<number>(nodes.length).fill(Infinity);
  const gapSum = new Array<number>(nodes.length).fill(0);
  const previous = new Array<number | null>(nodes.length).fill(null);
  const done = new Array<boolean>(nodes.length).fill(false);

  for (const node of nodes) {
    if (leftGap(node.id) <= maxGap) {
      cost[node.id] = leftGap(node.id) * AIR_GAP_WEIGHT + Math.max(0, node.cx - extent[node.id].min);
      gapSum[node.id] = leftGap(node.id);
    }
  }

  for (;;) {
    let current = -1;

    for (let id = 0; id < nodes.length; id += 1) {
      if (!done[id] && cost[id] < Infinity && (current === -1 || cost[id] < cost[current])) {
        current = id;
      }
    }

    if (current === -1) {
      break;
    }

    done[current] = true;

    for (const edge of graph[current]) {
      const step = Math.hypot(nodes[edge.to].cx - nodes[current].cx, nodes[edge.to].cy - nodes[current].cy);
      const next = cost[current] + edge.gap * AIR_GAP_WEIGHT + step;

      if (next < cost[edge.to] && gapSum[current] + edge.gap <= maxGap) {
        cost[edge.to] = next;
        gapSum[edge.to] = gapSum[current] + edge.gap;
        previous[edge.to] = current;
      }
    }
  }

  let goal: number | null = null;
  let best = Infinity;
  let totalGap = 0;

  for (const node of nodes) {
    const id = node.id;
    const exitGap = rightGap(id);

    if (cost[id] === Infinity || gapSum[id] + exitGap > maxGap) {
      continue;
    }

    const total = cost[id] + exitGap * AIR_GAP_WEIGHT + Math.max(0, extent[id].max - node.cx);

    if (total < best) {
      best = total;
      goal = id;
      totalGap = gapSum[id] + exitGap;
    }
  }

  if (goal === null) {
    return null;
  }

  const pathIds: number[] = [];

  for (let current: number | null = goal; current !== null; current = previous[current]) {
    pathIds.push(current);
  }

  pathIds.reverse();

  // Collect the air gaps the discharge actually crosses, for display.
  const arcs: AirArc[] = [];
  const first = nodes[pathIds[0]];
  const last = nodes[goal];
  const leftPoint = extremeVertex(first, -1);
  const rightPoint = extremeVertex(last, 1);

  if (leftGap(first.id) > CONTACT_EPSILON) {
    arcs.push({ from: { x: leftFace, y: leftPoint.y }, to: leftPoint, length: leftGap(first.id) });
  }

  for (let i = 1; i < pathIds.length; i += 1) {
    const pair = closestPair(nodes[pathIds[i - 1]].part.vertices, nodes[pathIds[i]].part.vertices);

    if (pair.distance > CONTACT_EPSILON) {
      arcs.push({ from: pair.from, to: pair.to, length: pair.distance });
    }
  }

  if (rightGap(last.id) > CONTACT_EPSILON) {
    arcs.push({ from: rightPoint, to: { x: rightFace, y: rightPoint.y }, length: rightGap(last.id) });
  }

  return {
    pathNodes: pathIds.map((id) => nodes[id]),
    leftX,
    rightX,
    totalGap,
    arcs,
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

function extremeVertex(node: PathNode, direction: -1 | 1): Point {
  return node.part.vertices.reduce((best, vertex) => (vertex.x * direction > best.x * direction ? vertex : best));
}

/** Returns the leading `fraction` (0..1) of a polyline by arc length. */
export function truncatePolyline(points: Point[], fraction: number): Point[] {
  if (fraction >= 1 || points.length < 2) {
    return points;
  }

  let total = 0;

  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }

  let remaining = total * Math.max(0, fraction);
  const output = [points[0]];

  for (let i = 1; i < points.length && remaining > 0; i += 1) {
    const length = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);

    if (length <= remaining) {
      output.push(points[i]);
      remaining -= length;
    } else {
      const t = remaining / length;
      output.push({
        x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
        y: points[i - 1].y + (points[i].y - points[i - 1].y) * t,
      });
      break;
    }
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

type Edge = { to: number; gap: number };

function buildGraph(nodes: PathNode[], maxGap: number): Edge[][] {
  const graph = Array.from({ length: nodes.length }, () => [] as Edge[]);

  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    const left = nodes[leftIndex];

    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const right = nodes[rightIndex];

      if (!boundsNear(left.bounds, right.bounds, Math.max(CONTACT_EPSILON, maxGap))) {
        continue;
      }

      const gap = airGap(left, right, maxGap);

      if (gap === null) {
        continue;
      }

      graph[leftIndex].push({ to: rightIndex, gap });
      graph[rightIndex].push({ to: leftIndex, gap });
    }
  }

  return graph;
}

function boundsNear(a: Matter.Bounds, b: Matter.Bounds, margin: number): boolean {
  return !(a.max.x < b.min.x - margin || b.max.x < a.min.x - margin || a.max.y < b.min.y - margin || b.max.y < a.min.y - margin);
}

/** Air gap between two blocks (0 when conducting by contact), or null if they cannot be bridged. */
function airGap(a: PathNode, b: PathNode, maxGap: number): number | null {
  if (a.parent === b.parent) {
    // Cells of one tetromino conduct only through shared edges, not diagonal corners.
    const size = Math.sqrt(a.part.area);
    return Math.hypot(a.cx - b.cx, a.cy - b.cy) <= size * 1.1 ? 0 : null;
  }

  // Different bodies: real outline distance, not rotated bounding boxes.
  const distance = polygonDistance(a.part.vertices, b.part.vertices);

  if (distance <= CONTACT_EPSILON) {
    return 0;
  }

  return distance <= maxGap ? distance : null;
}

type Point = { x: number; y: number };

type ClosestPair = { distance: number; from: Point; to: Point };

function polygonDistance(a: Point[], b: Point[]): number {
  return closestPair(a, b).distance;
}

/** Closest pair of boundary points between two convex polygons (distance 0 if they overlap). */
function closestPair(a: Point[], b: Point[]): ClosestPair {
  let best: ClosestPair = { distance: Infinity, from: a[0], to: b[0] };

  for (let i = 0; i < a.length; i += 1) {
    const a1 = a[i];
    const a2 = a[(i + 1) % a.length];

    for (let j = 0; j < b.length; j += 1) {
      const b1 = b[j];
      const b2 = b[(j + 1) % b.length];

      if (segmentsIntersect(a1, a2, b1, b2)) {
        return { distance: 0, from: a1, to: a1 };
      }

      const onB = closestOnSegment(a1, b1, b2);
      const onA = closestOnSegment(b1, a1, a2);
      const dB = Math.hypot(a1.x - onB.x, a1.y - onB.y);
      const dA = Math.hypot(b1.x - onA.x, b1.y - onA.y);

      if (dB < best.distance) {
        best = { distance: dB, from: a1, to: onB };
      }

      if (dA < best.distance) {
        best = { distance: dA, from: onA, to: b1 };
      }
    }
  }

  // One polygon fully inside the other (heavy overlap).
  if (pointInPolygon(a[0], b) || pointInPolygon(b[0], a)) {
    return { distance: 0, from: a[0], to: a[0] };
  }

  return best;
}

function closestOnSegment(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));

  return { x: a.x + t * dx, y: a.y + t * dy };
}

function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);

  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const pi = polygon[i];
    const pj = polygon[j];

    if (pi.y > point.y !== pj.y > point.y && point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y) + pi.x) {
      inside = !inside;
    }
  }

  return inside;
}
