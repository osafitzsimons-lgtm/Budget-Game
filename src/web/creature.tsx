import { lookFor, type Look } from '../shared/scoring';

// An original rice-grain sprout. Drawn entirely here; colours and pose follow his health.

const PALETTE: Record<Look, { body: string; bodyShade: string; leaf: string; leafEdge: string; cheek: string | null }> = {
  thriving: { body: '#fbf6e4', bodyShade: '#e9dfbf', leaf: '#3fae4a', leafEdge: '#2b8a36', cheek: '#f3a0a0' },
  fine: { body: '#f8f2dc', bodyShade: '#e3d8b5', leaf: '#5aa94f', leafEdge: '#3f8a3a', cheek: '#f0b0a8' },
  tired: { body: '#f3ead0', bodyShade: '#ddd0a6', leaf: '#b9b348', leafEdge: '#968f2e', cheek: null },
  wilting: { body: '#ece0c0', bodyShade: '#d4c49a', leaf: '#a3a13f', leafEdge: '#7a4b1e', cheek: null },
  failing: { body: '#d9d6cf', bodyShade: '#bdb9b0', leaf: '#9a988e', leafEdge: '#7c7a72', cheek: null },
  dead: { body: '#cfccc5', bodyShade: '#b3afa6', leaf: '#8f8c84', leafEdge: '#77746d', cheek: null },
};

export function lineFor(look: Look, name: string): string {
  switch (look) {
    case 'thriving': return `${name} is standing tall and waving at you.`;
    case 'fine': return `${name} is okay. One leaf is a bit droopy.`;
    case 'tired': return `${name} is going yellow and can barely keep his eyes open.`;
    case 'wilting': return `${name} is bent double. His leaves are going brown at the edges.`;
    case 'failing': return `${name} has gone grey and is down to one leaf. He might not make it.`;
    case 'dead': return `${name} didn't make it.`;
  }
}

export function speechFor(look: Look): string {
  switch (look) {
    case 'thriving': return 'We’re doing it! Keep going!';
    case 'fine': return 'I’m alright. Please keep being careful.';
    case 'tired': return 'I’m so tired… every dollar hurts a bit.';
    case 'wilting': return 'It really hurts. Please stop spending.';
    case 'failing': return 'I don’t think I can hold on much longer…';
    case 'dead': return '…';
  }
}

interface Props {
  health: number;
  size?: number;
  /** 'hurt' or 'happy' plays a one-off reaction */
  reaction?: 'hurt' | 'happy' | null;
  label?: string;
}

export function Sprout({ health, size = 220, reaction = null, label }: Props) {
  const look = lookFor(health);
  const c = PALETTE[look];
  const bent = look === 'wilting';
  const dead = look === 'dead';
  const tall = look === 'thriving';

  // Body: a rice grain (rounded, slightly pointed top) standing on the ground.
  const body = tall
    ? 'M100 62 C126 62 140 98 140 132 C140 166 124 186 100 186 C76 186 60 166 60 132 C60 98 74 62 100 62 Z'
    : 'M100 76 C126 76 140 106 140 138 C140 168 124 186 100 186 C76 186 60 168 60 138 C60 106 74 76 100 76 Z';
  const top = tall ? 62 : 76;

  const leaves: { d: string; cls: string }[] = [];
  if (look === 'thriving') {
    leaves.push({ d: `M100 ${top} C92 ${top - 30} 78 ${top - 44} 62 ${top - 48} C70 ${top - 30} 84 ${top - 12} 100 ${top} Z`, cls: 'leaf leaf-l' });
    leaves.push({ d: `M100 ${top} C100 ${top - 34} 104 ${top - 52} 112 ${top - 64} C116 ${top - 44} 110 ${top - 20} 100 ${top} Z`, cls: 'leaf leaf-m' });
    leaves.push({ d: `M100 ${top} C110 ${top - 28} 124 ${top - 40} 140 ${top - 42} C132 ${top - 24} 116 ${top - 10} 100 ${top} Z`, cls: 'leaf leaf-r' });
  } else if (look === 'fine') {
    leaves.push({ d: `M100 ${top} C100 ${top - 32} 104 ${top - 48} 112 ${top - 58} C116 ${top - 40} 110 ${top - 18} 100 ${top} Z`, cls: 'leaf leaf-m' });
    leaves.push({ d: `M100 ${top} C92 ${top - 26} 80 ${top - 38} 64 ${top - 40} C72 ${top - 24} 86 ${top - 10} 100 ${top} Z`, cls: 'leaf leaf-l' });
    // droopy leaf hanging down on the right
    leaves.push({ d: `M100 ${top} C116 ${top - 10} 134 ${top - 2} 142 ${top + 18} C126 ${top + 10} 112 ${top + 4} 100 ${top} Z`, cls: 'leaf leaf-droop' });
  } else if (look === 'tired' || look === 'wilting') {
    leaves.push({ d: `M100 ${top} C96 ${top - 22} 84 ${top - 32} 70 ${top - 30} C78 ${top - 18} 88 ${top - 6} 100 ${top} Z`, cls: 'leaf leaf-l' });
    leaves.push({ d: `M100 ${top} C114 ${top - 8} 130 ${top} 138 ${top + 20} C122 ${top + 12} 110 ${top + 6} 100 ${top} Z`, cls: 'leaf leaf-droop' });
  } else if (look === 'failing') {
    leaves.push({ d: `M100 ${top} C112 ${top - 4} 124 ${top + 6} 128 ${top + 24} C116 ${top + 14} 106 ${top + 8} 100 ${top} Z`, cls: 'leaf leaf-droop' });
  }

  const eyeY = tall ? 118 : 126;
  const mouthY = eyeY + 22;
  let eyes;
  if (dead) {
    eyes = (
      <g stroke="#3b3a36" stroke-width="3" stroke-linecap="round">
        <path d={`M80 ${eyeY - 5} l10 10 M90 ${eyeY - 5} l-10 10`} />
        <path d={`M110 ${eyeY - 5} l10 10 M120 ${eyeY - 5} l-10 10`} />
      </g>
    );
  } else if (look === 'tired' || look === 'wilting' || look === 'failing') {
    eyes = (
      <g>
        <ellipse cx="85" cy={eyeY + 2} rx="5" ry="4" fill="#2d2c29" />
        <ellipse cx="115" cy={eyeY + 2} rx="5" ry="4" fill="#2d2c29" />
        {/* heavy eyelids */}
        <path d={`M78 ${eyeY - 1} Q85 ${eyeY - 6} 92 ${eyeY - 1} Z`} fill={c.bodyShade} />
        <path d={`M108 ${eyeY - 1} Q115 ${eyeY - 6} 122 ${eyeY - 1} Z`} fill={c.bodyShade} />
        <path d={`M78 ${eyeY} H92 M108 ${eyeY} H122`} stroke="#2d2c29" stroke-width="2" stroke-linecap="round" />
      </g>
    );
  } else {
    eyes = (
      <g class={look === 'thriving' ? 'blink' : ''}>
        <ellipse cx="85" cy={eyeY} rx="5.5" ry="7" fill="#2d2c29" />
        <ellipse cx="115" cy={eyeY} rx="5.5" ry="7" fill="#2d2c29" />
        <circle cx="87" cy={eyeY - 3} r="1.8" fill="#fff" />
        <circle cx="117" cy={eyeY - 3} r="1.8" fill="#fff" />
      </g>
    );
  }

  const mouth = {
    thriving: `M88 ${mouthY} Q100 ${mouthY + 12} 112 ${mouthY}`,
    fine: `M90 ${mouthY + 2} Q100 ${mouthY + 8} 110 ${mouthY + 2}`,
    tired: `M91 ${mouthY + 4} H109`,
    wilting: `M89 ${mouthY + 8} Q100 ${mouthY} 111 ${mouthY + 8}`,
    failing: `M89 ${mouthY + 9} Q100 ${mouthY - 1} 111 ${mouthY + 9}`,
    dead: `M91 ${mouthY + 5} H109`,
  }[look];

  const pose = dead ? 'translate(36 6) rotate(-80 100 186) scale(0.85) translate(18 33)' : bent ? 'rotate(28 100 186)' : '';
  const classes = ['sprout', `look-${look}`, reaction ? `react-${reaction}` : ''].join(' ');
  const desc = label ?? lineFor(look, 'He');

  return (
    <svg class={classes} viewBox="0 0 200 220" width={size} height={size * 1.1} role="img" aria-label={desc}>
      <ellipse cx="100" cy="196" rx={dead ? 70 : 52} ry="8" fill="currentColor" opacity="0.12" />
      <g class="sprout-sway">
        <g transform={pose}>
          <g class="sprout-breathe">
            {leaves.map((l) => (
              <path d={l.d} class={l.cls} fill={c.leaf} stroke={c.leafEdge} stroke-width={look === 'wilting' ? 4 : 1.5} stroke-linejoin="round" />
            ))}
            <path d={body} fill={c.body} stroke={c.bodyShade} stroke-width="3" />
            <path d="M74 150 C78 172 90 180 100 181" fill="none" stroke={c.bodyShade} stroke-width="3" stroke-linecap="round" opacity="0.8" />
            {/* arms */}
            {look === 'thriving' ? (
              <g>
                <path d="M62 140 C50 146 44 154 42 162" fill="none" stroke={c.leafEdge} stroke-width="5" stroke-linecap="round" />
                <g class="wave-arm">
                  <path d="M138 128 C150 118 156 106 158 94" fill="none" stroke={c.leafEdge} stroke-width="5" stroke-linecap="round" />
                </g>
              </g>
            ) : !dead ? (
              <g>
                <path d="M62 146 C54 156 52 164 52 172" fill="none" stroke={c.leafEdge} stroke-width="5" stroke-linecap="round" />
                <path d="M138 146 C146 156 148 164 148 172" fill="none" stroke={c.leafEdge} stroke-width="5" stroke-linecap="round" />
              </g>
            ) : null}
            {eyes}
            {c.cheek && (
              <g fill={c.cheek} opacity="0.55">
                <ellipse cx="74" cy={eyeY + 14} rx="7" ry="4" />
                <ellipse cx="126" cy={eyeY + 14} rx="7" ry="4" />
              </g>
            )}
            <path d={mouth} fill="none" stroke="#2d2c29" stroke-width="3" stroke-linecap="round" />
            {(look === 'wilting' || look === 'tired') && <path class="sweat" d={`M128 ${eyeY - 14} q5 8 0 12 q-5 -4 0 -12 Z`} fill="#8cc8e8" />}
            {look === 'failing' && <path class="tear" d={`M84 ${eyeY + 8} q4 7 0 11 q-4 -4 0 -11 Z`} fill="#8cc8e8" />}
          </g>
        </g>
      </g>
      {dead && <path d="M150 194 C158 186 170 184 178 188 C170 194 160 196 150 194 Z" fill={c.leaf} stroke={c.leafEdge} />}
    </svg>
  );
}
