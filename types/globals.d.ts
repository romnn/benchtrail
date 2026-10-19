import type * as echarts from "echarts";

// The history file that github-action-benchmark commits next to the page.
// It is untrusted input, so the page validates every field before reading it.
interface BenchmarkData {
  lastUpdate: number;
  repoUrl: string;
  entries: Record<string, BenchmarkRun[]>;
}

interface BenchmarkRun {
  commit: {
    author: { name?: string; username?: string; email?: string };
    committer?: { name?: string; username?: string; email?: string };
    id: string;
    message: string;
    timestamp: string;
    url: string;
  };
  date: number;
  tool: string;
  benches: BenchmarkEntry[];
}

interface BenchmarkEntry {
  name: string;
  value: number;
  unit: string;
  range?: string;
  extra?: string;
}

declare global {
  interface Window {
    // Set by the ECharts script tag in index.html, which must load before the module runs.
    echarts: typeof echarts;
    BENCHMARK_DATA?: BenchmarkData;
  }
}
