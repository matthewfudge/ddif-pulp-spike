import { useState } from 'react';
import { View, Knob, SvgPath } from '@pulp/react';

// One knob = grey ring (static SvgPath) + purple triangle indicator
// (SvgPath whose transform.rotate follows the Knob's value).
function AnimatedKnob({ id, x, y, size = 120, label }) {
  const [v, setV] = useState(0.5);
  // Pulp's default knob arc spans roughly -135deg to +135deg = 270deg sweep.
  const angle = v * 270 - 135;
  const r = size / 2;

  return (
    <View style={{position:'absolute', left:x, top:y, width:size, height:size}}>
      {/* Static grey ring — Pulp will paint this every frame, no transform. */}
      <SvgPath
        d={`M ${r},${r * 0.15} A ${r * 0.85},${r * 0.85} 0 1,1 ${r * 0.999},${r * 1.0}`}
        viewBox={[size, size]}
        fill="none"
        stroke="#e8e1d5"
        strokeWidth={3}
        style={{position:'absolute', left:0, top:0, width:size, height:size, pointerEvents:'none'}}
      />
      {/* Pulp's interactive Knob, invisible — catches mouse. Drag updates v. */}
      <Knob
        id={id}
        value={v}
        onChange={setV}
        style={{position:'absolute', left:0, top:0, width:size, height:size, opacity:0}}
      />
      {/* Purple triangle indicator — rotates with v. Pointer at the top,
          two base points below, pivoted at the knob center. */}
      <SvgPath
        d={`M ${r},${r * 0.25} L ${r * 0.85},${r * 0.55} L ${r * 1.15},${r * 0.55} Z`}
        viewBox={[size, size]}
        fill="#7b6896"
        style={{
          position: 'absolute', left: 0, top: 0, width: size, height: size,
          transform: [{ rotate: `${angle}deg` }],
          transformOrigin: '50% 50%',
          pointerEvents: 'none',
        }}
      />
    </View>
  );
}

export default function App() {
  return (
    <View style={{position:'absolute', left:0, top:0, width:1000, height:536}}>
      <AnimatedKnob id="macro1" x={100} y={150} size={140} />
      <AnimatedKnob id="macro2" x={350} y={150} size={140} />
      <AnimatedKnob id="threshold" x={750} y={150} size={140} />
    </View>
  );
}
