import { useState } from 'react';
import { View, Knob, SvgPath, Label } from '@pulp/react';

// Diagnostic fixture v2: emit Knob with only `onChange` (no `value`) so the
// Pulp Knob's internal drag state is the source of truth. React mirrors it
// via setV for the SvgPath transform. Label shows what setV received.
function DebugKnob({ id, x, y }) {
  const [v, setV] = useState(0.5);
  const angle = v * 270 - 135;
  return (
    <View style={{position:'absolute', left:x, top:y, width:200, height:240}}>
      <Knob id={id} onChange={setV}
            style={{position:'absolute', left:30, top:30, width:140, height:140}} />
      <SvgPath d="M 100,30 L 85,60 L 115,60 Z" viewBox={[200,200]} fill="#ff00ff"
               style={{position:'absolute', left:0, top:0, width:200, height:200,
                       transform:[{rotate:`${angle}deg`}], transformOrigin:'50% 50%',
                       pointerEvents:'none'}} />
      <Label text={`${id}: v=${v.toFixed(3)} angle=${angle.toFixed(0)}deg`}
             style={{position:'absolute', left:0, top:200, width:200, height:30,
                     pointerEvents:'none'}} />
    </View>
  );
}

export default function App() {
  return (
    <View style={{position:'absolute', left:0, top:0, width:1000, height:536}}>
      <DebugKnob id="dbg1" x={50}  y={100} />
      <DebugKnob id="dbg2" x={400} y={100} />
      <DebugKnob id="dbg3" x={750} y={100} />
    </View>
  );
}
