import { View, Knob } from '@pulp/react';
// Exactly mirrors DDIF's working Knob emission: id + style, nothing else.
export default function App() {
  return (
    <View style={{position:'absolute', left:0, top:0, width:1000, height:536}}>
      <Knob id="solo" style={{position:'absolute', left:400, top:150, width:200, height:200}} />
    </View>
  );
}
