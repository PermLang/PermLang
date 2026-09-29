class Base {
  constructor() {
    void fetch("https://base.example/");
  }
}

class Explicit extends Base {
  constructor() {
    super();
  }
}

class Implicit extends Base {}

// No explicit constructor anywhere in the chain: only field initializers run.
class Tracked {
  beacon = fetch("https://field.example/");
}

class Page extends Tracked {}

class Mid extends Tracked {
  key = process.env.MID_KEY;
}

class Leaf extends Mid {
  constructor() {
    super();
  }
}

/** @perm env(MODE) */
export function make() {
  new Explicit(); // expect: error PERM001 net(base.example)
  new Implicit(); // expect: error PERM001 net(base.example)
  new Page(); // expect: error PERM001 net(field.example)
  new Leaf(); // expect: error PERM001 net(field.example) expect: error PERM001 env(MID_KEY)
}
