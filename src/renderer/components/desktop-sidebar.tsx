import {
  Activity,
  AudioLines,
  BookUser,
  Boxes,
  FlaskConical,
  ListTree,
  MessageSquareText,
  ScrollText,
  Settings2,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export const DESKTOP_SECTIONS = [
  { id: 'simulation', title: 'Simulation', icon: Activity, group: 'workspace' },
  { id: 'playground', title: 'Playground', icon: FlaskConical, group: 'workspace' },
  { id: 'inspector', title: 'Run Inspector', icon: ListTree, group: 'workspace' },
  { id: 'audience', title: 'Audience', icon: BookUser, group: 'workspace' },
  { id: 'inputs', title: 'Inputs', icon: AudioLines, group: 'workspace' },
  { id: 'models', title: 'Models', icon: Boxes, group: 'workspace' },
  { id: 'chat', title: 'Chat & Overlay', icon: MessageSquareText, group: 'workspace' },
  { id: 'logs', title: 'Logs', icon: ScrollText, group: 'application' },
  { id: 'settings', title: 'Settings', icon: Settings2, group: 'application' },
] as const satisfies readonly {
  id: string;
  title: string;
  icon: LucideIcon;
  group: 'workspace' | 'application';
}[];

export type DesktopSection = (typeof DESKTOP_SECTIONS)[number]['id'];

interface DesktopSidebarProps {
  readonly selected: DesktopSection;
  readonly onSelect: (section: DesktopSection) => void;
  readonly simulationPhase: 'stopped' | 'starting' | 'running' | 'switching' | 'error';
  readonly unreadErrors?: number;
}

export function DesktopSidebar({
  selected,
  onSelect,
  simulationPhase,
  unreadErrors = 0,
}: DesktopSidebarProps) {
  return (
    <aside className="shrink-0 border-b border-border bg-[#181820] sm:sticky sm:top-0 sm:flex sm:h-dvh sm:w-52 sm:flex-col sm:border-r sm:border-b-0 lg:w-60">
      <div className="hidden items-center gap-3 border-b border-border/60 px-5 py-5 sm:flex">
        <span className="rounded-lg bg-violet-500/20 p-2 text-violet-300">
          <MessageSquareText aria-hidden="true" className="size-5" />
        </span>
        <div>
          <p className="font-semibold tracking-tight">Lonely Chat</p>
          <p className="text-xs text-muted-foreground">Local simulated audience</p>
        </div>
      </div>
      <nav
        aria-label="Main navigation"
        className="flex gap-1 overflow-x-auto p-2 sm:min-h-0 sm:flex-1 sm:flex-col sm:overflow-y-auto sm:p-3"
      >
        {DESKTOP_SECTIONS.map(({ id, title, icon: Icon, group }, index) => (
          <div
            key={id}
            className={cn(
              'shrink-0 sm:shrink',
              group === 'application' &&
                DESKTOP_SECTIONS[index - 1]?.group !== 'application' &&
                'sm:mt-auto',
            )}
          >
            {index > 0 && DESKTOP_SECTIONS[index - 1].group !== group && (
              <div aria-hidden="true" className="my-3 hidden border-t border-border/70 sm:block" />
            )}
            <Button
              type="button"
              aria-label={title}
              variant="ghost"
              size="lg"
              aria-current={selected === id ? 'page' : undefined}
              onClick={() => onSelect(id)}
              className={cn(
                'h-9 justify-start gap-3 px-3 text-sm font-medium sm:w-full',
                selected === id
                  ? 'bg-violet-500/15 text-violet-200 hover:bg-violet-500/20'
                  : 'text-zinc-400 hover:text-foreground',
              )}
            >
              <Icon aria-hidden="true" className="size-4" />
              {title}
              {id === 'logs' && unreadErrors > 0 && (
                <span
                  aria-label={`${unreadErrors} unread log errors`}
                  className="ml-auto rounded-full bg-rose-600 px-1.5 py-0.5 text-[10px] font-semibold text-white"
                >
                  {unreadErrors > 99 ? '99+' : unreadErrors}
                </span>
              )}
              {id === 'simulation' && simulationPhase === 'error' && (
                <span
                  className="ml-auto size-2 rounded-full bg-rose-400"
                  aria-label="Simulation error"
                />
              )}
              {id === 'simulation' &&
                (simulationPhase === 'running' ||
                  simulationPhase === 'starting' ||
                  simulationPhase === 'switching') && (
                  <span
                    className="ml-auto size-2 rounded-full bg-emerald-400"
                    aria-label="Simulation running"
                  />
                )}
            </Button>
          </div>
        ))}
      </nav>
    </aside>
  );
}
