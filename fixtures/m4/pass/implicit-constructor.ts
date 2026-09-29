// Classes with no side effects in their constructors add nothing.
class Point {
  x = 0;
  y = 0;
}

class Point3 extends Point {
  z = 0;
}

/** @perm env(MODE) */
export function origin() {
  return new Point3();
}
