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
  const goalIds = nodes.filter((node) => node.bounds.max.x >= rightX - slack).map((node) => node.id);

  if (startIds.length === 0 || goalIds.length === 0) {
    return null;
  }

  // Dijkstra on conduction distance: edge cost is the center-to-center distance, entry/exit cost is the
  // horizontal run from the band edge. This yields the geometrically shortest path, not just the fewest blocks.
  const dist = new Array<number>(nodes.length).fill(Infinity);
  const previous = new Array<number | null>(nodes.length).fill(null);
  const done = new Array<boolean>(nodes.length).fill(false);

  for (const id of startIds) {
    dist[id] = Math.max(0, nodes[id].cx - leftX);
  }

  for (;;) {
    let current = -1;

    for (let id = 0; id < nodes.length; id += 1) {
      if (!done[id] && dist[id] < Infinity && (current === -1 || dist[id] < dist[current])) {
        current = id;
      }
    }

    if (current === -1) {
      break;
    }

    done[current] = true;

    for (const neighborId of graph[current]) {
      const cost = dist[current] + Math.hypot(nodes[neighborId].cx - nodes[current].cx, nodes[neighborId].cy - nodes[current].cy);

      if (cost < dist[neighborId]) {
        dist[neighborId] = cost;
        previous[neighborId] = current;
      }
    }
  }

  let goal: number | null = null;
  let best = Infinity;

  for (const id of goalIds) {
    const total = dist[id] + Math.max(0, rightX - nodes[id].cx);

    if (total < best) {
      best = total;
      goal = id;
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

function buildGraph(nodes: PathNode[]): number[][] {
  const graph = Array.from({ length: nodes.length }, () => [] as number[]);

  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    const left = nodes[leftIndex];

    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const right = nodes[rightIndex];

      if (!boundsNear(left.bounds, right.bounds) || !areConnected(left, right)) {
        continue;
      }

      graph[leftIndex].push(rightIndex);
      graph[rightIndex].push(leftIndex);
    }
  }

  return graph;
}

function boundsNear(a: Matter.Bounds, b: Matter.Bounds): boolean {
  return !(
    a.max.x < b.min.x - CONTACT_EPSILON ||
    b.max.x < a.min.x - CONTACT_EPSILON ||
    a.max.y < b.min.y - CONTACT_EPSILON ||
    b.max.y < a.min.y - CONTACT_EPSILON
  );
}

function areConnected(a: PathNode, b: PathNode): boolean {
  if (a.parent === b.parent) {
    // Cells of one tetromino conduct only through shared edges, not diagonal corners.
    const size = Math.sqrt(a.part.area);
    return Math.hypot(a.cx - b.cx, a.cy - b.cy) <= size * 1.1;
  }

  // Different bodies conduct when their actual outlines touch, not merely their (rotated) bounding boxes.
  return polygonDistance(a.part.vertices, b.part.vertices) <= CONTACT_EPSILON;
}

type Point = { x: number; y: number };

function polygonDistance(a: Point[], b: Point[]): number {
  let min = Infinity;

  for (let i = 0; i < a.length; i += 1) {
    const a1 = a[i];
    const a2 = a[(i + 1) % a.length];

    for (let j = 0; j < b.length; j += 1) {
      const b1 = b[j];
      const b2 = b[(j + 1) % b.length];

      if (segmentsIntersect(a1, a2, b1, b2)) {
        return 0;
      }

      min = Math.min(min, pointSegmentDistance(a1, b1, b2), pointSegmentDistance(b1, a1, a2));
    }
  }

  // One polygon fully inside the other (heavy overlap).
  if (pointInPolygon(a[0], b) || pointInPolygon(b[0], a)) {
    return 0;
  }

  return min;
}

function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));

  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
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
