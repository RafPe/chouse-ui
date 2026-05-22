import { motion } from "framer-motion";
import { SunMoon, Gauge, FileSearch, ArrowUpRight, type LucideIcon } from "lucide-react";
import { Section, Container } from "./Section";

/**
 * Release-highlight strip for the most recent version. Deliberately NOT part
 * of the numbered section sequence — it reads as a callout banner, marked by
 * the version tag instead of an "0N" index. Update RELEASE + ITEMS each time
 * a release ships a few headline features worth surfacing above the fold.
 */

const RELEASE = "v2.15.0";

interface NewItem {
  icon: LucideIcon;
  title: string;
  desc: string;
}

const ITEMS: NewItem[] = [
  {
    icon: SunMoon,
    title: "Light + dark, auto by time",
    desc: "Full light theme on a warm-stone palette, plus an Auto mode that follows your local clock. Every chart, table, and pill is theme-aware.",
  },
  {
    icon: Gauge,
    title: "Monitoring deep-dive",
    desc: "Server memory breakdown, top memory/CPU queries, blocked-task indicators, per-replica lag, and p50/p95/p99 latency — no exporter required.",
  },
  {
    icon: FileSearch,
    title: "By Redash rollup",
    desc: "Group every query by the Redash query_id in its SQL comment, so cluster load maps straight back to the saved dashboard that caused it.",
  },
];

const EASE = [0.16, 1, 0.3, 1] as const;

export default function WhatsNew() {
  return (
    <Section id="whats-new" aria-label="What's new" dense>
      <Container>
        {/* Header row — version tag instead of a numbered eyebrow */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.5, ease: EASE }}
          className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between"
        >
          <div className="flex flex-col gap-4">
            <span className="label-mono inline-flex items-center gap-3">
              <span className="inline-flex items-center gap-1.5 rounded-xs border border-accent/40 px-2 py-0.5 text-accent">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden />
                {RELEASE}
              </span>
              <span className="h-px w-6 bg-ink-700" aria-hidden />
              <span>Latest release</span>
            </span>
            <h2 className="text-display-lg font-semibold text-paper text-balance">
              What shipped recently.
            </h2>
          </div>

          <a
            href="#changelog"
            className="group inline-flex items-center gap-2 self-start rounded-xs border border-ink-500 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-paper-muted transition-colors hover:border-ink-700 hover:text-paper md:self-auto"
          >
            Full changelog
            <ArrowUpRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </a>
        </motion.div>

        {/* Cards — stagger in on scroll */}
        <div className="mt-12 grid grid-cols-1 gap-px overflow-hidden rounded-md border border-ink-500 bg-ink-500 md:grid-cols-3">
          {ITEMS.map((item, idx) => {
            const Icon = item.icon;
            return (
              <motion.div
                key={item.title}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-60px" }}
                transition={{ duration: 0.55, delay: 0.08 + idx * 0.1, ease: EASE }}
                className="group flex flex-col gap-4 bg-ink-100 p-6 transition-colors hover:bg-ink-200 md:p-8"
              >
                <div className="flex items-center justify-between">
                  <span className="grid h-10 w-10 place-items-center rounded-xs border border-ink-500 bg-ink-200 text-paper transition-colors group-hover:border-accent group-hover:text-accent">
                    <Icon className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-accent">
                    New
                  </span>
                </div>
                <div className="flex flex-col gap-2">
                  <h3 className="text-[17px] font-semibold leading-tight text-paper">
                    {item.title}
                  </h3>
                  <p className="text-sm leading-relaxed text-paper-muted">{item.desc}</p>
                </div>
              </motion.div>
            );
          })}
        </div>
      </Container>
    </Section>
  );
}
