// Home-theatre fork: open the full-screen player over whatever Seerr page you're on.
// It mounts its own React root on <body>, so no Seerr layout code has to know about it.
import { mutate } from 'swr';

let close: (() => void) | null = null;

/** Something not in the library yet: request it and play once it's there. */
export interface PrepareTarget {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  seasonNumber?: number;
  title?: string;
}

export async function openPlayer(
  target: string | { prepare: PrepareTarget }
): Promise<void> {
  close?.();
  const [{ createRoot }, { default: Player }] = await Promise.all([
    import('react-dom/client'),
    import('@app/components/Watch/Player'),
  ]);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const overflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  close = () => {
    close = null;
    root.unmount();
    host.remove();
    document.body.style.overflow = overflow;
    // Progress changed: refresh Continue Watching, card badges, episode lists.
    mutate(
      (key) => typeof key === 'string' && key.startsWith('/api/v1/watch/'),
      undefined,
      { revalidate: true }
    );
  };
  root.render(
    typeof target === 'string' ? (
      <Player jellyfinId={target} onClose={() => close?.()} />
    ) : (
      <Player prepare={target.prepare} onClose={() => close?.()} />
    )
  );
}
