export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") return new Response("ok");

    if (url.pathname === "/ws") {
      if ((req.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      const room = url.searchParams.get("room") || "default";
      const id = env.ROOMS.idFromName(room);
      const stub = env.ROOMS.get(id);
      return stub.fetch(req);
    }

    return new Response("Not found", { status: 404 });
  },
};

// Типи
type PID = "p1" | "p2";
type Bot = { x:number; y:number; a:number; vx:number; vy:number; wa:number; l:number; r:number; };
type InputMsg = { t:"input"; l:number; r:number; };

function clamp(v:number,a:number,b:number){ return v<a?a:(v>b?b:v); }

export class RoomDO {
  state: DurableObjectState;
  env: Env;

  // Гравці
  wsByPid: Record<PID, WebSocket | null> = { p1: null, p2: null };
  pidByWs = new Map<WebSocket, PID>();

  // Вхідні дані
  inputs: Record<PID, { l:number; r:number }> = { p1:{l:0,r:0}, p2:{l:0,r:0} };

  // Фізика
  bots: Record<PID, Bot>;

  tick = 0;
  loopStarted = false;

  // ФАЗА
  phase: "lobby" | "countdown" | "fight" | "end";
  fightStartTime: number = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // === НАЛАШТУВАННЯ: ВІДСТАНЬ 300 пікселів ===
    this.bots = {
      p1:{x:-150,y:0,a:0,       vx:0,vy:0,wa:0,l:0,r:0},
      p2:{x: 150,y:0,a:Math.PI,vx:0,vy:0,wa:0,l:0,r:0},
    };

    // === ХИТРІСТЬ: Одразу ставимо фазу "fight" для тестів ===
    this.phase = "fight"; 
  }

  // --- Helpers ---
  private visibleBots(){
    return {
      p1: { x: this.bots.p1.x, y: this.bots.p1.y, a: this.bots.p1.a },
      p2: { x: this.bots.p2.x, y: this.bots.p2.y, a: this.bots.p2.a }
    };
  }

  // --- WebSocket Logic ---
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/ws") return new Response("ok");

    const pair = new WebSocketPair();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = (pair as any)[0] as WebSocket;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const server = (pair as any)[1] as WebSocket;

    server.accept();

    // Спрощена логіка: займаємо p1, якщо вільно, інакше p2
    let pid: PID = "p1";
    if (this.wsByPid.p1) pid = "p2";

    this.wsByPid[pid] = server;
    this.pidByWs.set(server, pid);

    // Привітання (одразу кажемо, що фаза fight)
    server.send(JSON.stringify({ 
      t:"hello", 
      pid, 
      bots:this.visibleBots(), 
      phase:this.phase 
    }));

    server.addEventListener("message", (ev) => {
      try {
        const data = JSON.parse(typeof ev.data === "string" ? ev.data : "");
        const who: PID = this.pidByWs.get(server) || pid;

        if (data?.t === "input") {
          const m = data as InputMsg;
          this.inputs[who] = {
            l: clamp(Number(m.l) || 0, -100, 100),
            r: clamp(Number(m.r) || 0, -100, 100),
          };
        }
        
        // Рестарт
        if (data?.t === "restart") {
           this.resetBots();
        }

      } catch (e) {}
    });

    server.addEventListener("close", () => {
      this.pidByWs.delete(server);
      if (this.wsByPid[pid] === server) {
        this.wsByPid[pid] = null;
      }
    });

    if (!this.loopStarted) {
      this.loopStarted = true;
      await this.state.storage.setAlarm(Date.now() + 33);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // --- Game Loop ---
  async alarm() {
    // Економія: спимо тільки якщо геть нікого немає
    if (!this.wsByPid.p1 && !this.wsByPid.p2) {
      this.loopStarted = false; 
      return; 
    }

    const dt = 1/30;
    this.tick++;

    // === ФІЗИКА ЗАВЖДИ ПРАЦЮЄ (без перевірки фази) ===
    for (const pid of ["p1","p2"] as const) {
      const b = this.bots[pid];
      const inp = this.inputs[pid];
      b.l = inp.l; 
      b.r = inp.r;
    }

    this.stepBot(this.bots.p1, dt);
    this.stepBot(this.bots.p2, dt);
    this.resolveCollision();

    // Переможець
    let winner: PID | null = null;
    const R = 400 - 22;
    if (Math.hypot(this.bots.p1.x, this.bots.p1.y) > R) winner = "p2";
    else if (Math.hypot(this.bots.p2.x, this.bots.p2.y) > R) winner = "p1";

    if (winner) {
        this.resetBots(); // Респавн при вильоті
    }

    // Broadcast (~10Hz)
    if (this.tick % 3 === 0) {
      this.broadcast(JSON.stringify({ 
        t:"state", 
        bots:this.visibleBots(), 
        phase:"fight", // Завжди кажемо клієнту, що бій йде
        winner, 
        msLeft: 0 
      }));
    }

    await this.state.storage.setAlarm(Date.now() + 33);
  }

  // --- Methods ---

  resetBots(){
    // Скидаємо на позиції -150 та 150
    this.bots.p1 = {x:-150,y:0,a:0,       vx:0,vy:0,wa:0,l:0,r:0};
    this.bots.p2 = {x: 150,y:0,a:Math.PI,vx:0,vy:0,wa:0,l:0,r:0};
    this.inputs.p1 = {l:0,r:0}; 
    this.inputs.p2 = {l:0,r:0};
  }

  broadcast(msg: string){
    if (this.wsByPid.p1) this.wsByPid.p1.send(msg);
    if (this.wsByPid.p2) this.wsByPid.p2.send(msg);
  }

  stepBot(b: Bot, dt: number) {
    const maxSpeed = 240;
    const wheelBase = 60;
    const targVL = (b.l/100) * maxSpeed;
    const targVR = (b.r/100) * maxSpeed;
    
    const v = (targVL + targVR) * 0.5;
    const w = (targVR - targVL) / wheelBase;

    b.vx = Math.cos(b.a) * v;
    b.vy = Math.sin(b.a) * v;
    b.wa = w;

    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.a += b.wa * dt;
  }

  resolveCollision() {
    const b1=this.bots.p1, b2=this.bots.p2;
    const minDist = 44; // 22 + 22
    const dx=b2.x-b1.x, dy=b2.y-b1.y;
    const d=Math.hypot(dx,dy) || 0.001;
    
    if (d<minDist){
      const push=(minDist-d)*0.5;
      const nx=dx/d, ny=dy/d;
      b1.x -= nx*push; b1.y -= ny*push;
      b2.x += nx*push; b2.y += ny*push;
    }
  }
}

export interface Env {
  ROOMS: DurableObjectNamespace;
}
