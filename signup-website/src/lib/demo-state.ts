export type DemoGame = {
  id: string;
  name: string;
  description: string;
  palette: readonly [string, string, string];
  sizeLabel: string;
  mods: readonly { id: string; name: string }[];
};

export const DEMO_GAMES: readonly DemoGame[] = [
  {
    id: "cloud-gardens",
    name: "Cloud Gardens",
    description: "Build a quiet garden among floating islands.",
    palette: ["#163B35", "#65C7A2", "#D9F7BC"],
    sizeLabel: "2.4 GB",
    mods: [{ id: "moonlit-plants", name: "Moonlit Plants" }, { id: "glass-greenhouse", name: "Glass Greenhouse" }],
  },
  {
    id: "orbital-post",
    name: "Orbital Post",
    description: "Deliver parcels between colorful space stations.",
    palette: ["#221B49", "#9D84FF", "#FFD580"],
    sizeLabel: "4.8 GB",
    mods: [{ id: "pastel-ships", name: "Pastel Ships" }, { id: "star-map", name: "Expanded Star Map" }],
  },
  {
    id: "tidal-trails",
    name: "Tidal Trails",
    description: "Explore coastal paths and discover hidden coves.",
    palette: ["#103B55", "#54C6D2", "#FFE3AC"],
    sizeLabel: "3.1 GB",
    mods: [{ id: "sunset-skies", name: "Sunset Skies" }, { id: "extra-coves", name: "Extra Coves" }],
  },
  {
    id: "copper-valley",
    name: "Copper Valley",
    description: "Connect a mountain community with miniature railways.",
    palette: ["#482C29", "#D79064", "#F8DFA5"],
    sizeLabel: "5.2 GB",
    mods: [{ id: "vintage-trains", name: "Vintage Trains" }, { id: "alpine-stations", name: "Alpine Stations" }],
  },
  {
    id: "paper-orchard",
    name: "Paper Orchard",
    description: "Fold a storybook landscape into a flourishing orchard.",
    palette: ["#49314E", "#DC93B0", "#F9EBC8"],
    sizeLabel: "1.6 GB",
    mods: [{ id: "autumn-paper", name: "Autumn Paper" }, { id: "origami-birds", name: "Origami Birds" }],
  },
  {
    id: "lantern-harbor",
    name: "Lantern Harbor",
    description: "Light up a seaside town with handcrafted lanterns.",
    palette: ["#202C4C", "#F2B56B", "#FFF0BA"],
    sizeLabel: "3.7 GB",
    mods: [{ id: "festival-lights", name: "Festival Lights" }, { id: "houseboats", name: "Houseboats" }],
  },
];

export type DemoJob = {
  id: string;
  gameId: string;
  kind: "game" | "mod";
  modIds: string[];
  status: "downloading" | "paused" | "completed" | "cancelled";
  progress: number;
};

export type DemoState = {
  jobs: DemoJob[];
  installed: Record<string, { appliedModIds: string[] }>;
};

export type DemoAction =
  | { type: "download"; gameId: string }
  | { type: "apply-mods"; gameId: string; modIds: string[] }
  | { type: "tick" }
  | { type: "pause" | "resume" | "cancel"; jobId: string }
  | { type: "reset" };

export function createDemoState(): DemoState {
  return { jobs: [], installed: { "cloud-gardens": { appliedModIds: [] } } };
}

/** Pure transitions; the UI may dispatch tick every 700 ms for +10% progress. */
export function demoReducer(state: DemoState, action: DemoAction): DemoState {
  switch (action.type) {
    case "reset":
      return createDemoState();
    case "download":
    case "apply-mods": {
      const game = DEMO_GAMES.find(({ id }) => id === action.gameId);
      if (!game || state.jobs.some((job) => job.gameId === game.id &&
        (job.status === "downloading" || job.status === "paused"))) return state;

      const installed = state.installed[game.id];
      let modIds: string[] = [];
      if (action.type === "download") {
        if (installed) return state;
      } else {
        if (!installed || action.modIds.some((id) => !game.mods.some((mod) => mod.id === id))) return state;
        modIds = [...new Set(action.modIds)].filter((id) => !installed.appliedModIds.includes(id));
        if (modIds.length === 0) return state;
      }

      return {
        ...state,
        jobs: [...state.jobs, {
          id: `job-${state.jobs.length + 1}`,
          gameId: game.id,
          kind: action.type === "download" ? "game" : "mod",
          modIds,
          status: "downloading",
          progress: 0,
        }],
      };
    }
    case "tick": {
      if (!state.jobs.some((job) => job.status === "downloading")) return state;
      const installed = { ...state.installed };
      const jobs = state.jobs.map((job): DemoJob => {
        if (job.status !== "downloading") return job;
        const progress = Math.min(100, job.progress + 10);
        if (progress < 100) return { ...job, progress };
        installed[job.gameId] = {
          appliedModIds: job.kind === "game" ? [] :
            [...new Set([...(installed[job.gameId]?.appliedModIds ?? []), ...job.modIds])],
        };
        return { ...job, progress, status: "completed" };
      });
      return { jobs, installed };
    }
    case "pause":
    case "resume":
    case "cancel": {
      const job = state.jobs.find(({ id }) => id === action.jobId);
      if (!job || (action.type === "resume" ? job.status !== "paused" :
        action.type === "pause" ? job.status !== "downloading" :
          job.status !== "downloading" && job.status !== "paused")) return state;
      const status = action.type === "pause" ? "paused" : action.type === "resume" ? "downloading" : "cancelled";
      return { ...state, jobs: state.jobs.map((item) => item.id === job.id ? { ...item, status } : item) };
    }
  }
}
