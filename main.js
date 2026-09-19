import {createState,apply} from './game.js';import {Renderer} from './renderer.js';import {Input} from './input.js';import {save,load,clear} from './storage.js';
const canvas=document.querySelector('#game'),renderer=new Renderer(canvas);let state=createState();let saving=Promise.resolve();
const pause=document.querySelector('#pause'),screen=document.querySelector('#pauseScreen');
function draw(){renderer.render(state)}
function commit(next){state=next;draw();saving=saving.then(()=>save(state)).catch(()=>{})}
new Input(renderer,()=>state,(id,index)=>{if(state.paused)return;commit(apply(state,{type:'play',cardId:id,index}))});
pause.onclick=()=>commit(apply(state,{type:state.paused?'resume':'pause'}));document.querySelector('#resume').onclick=()=>commit(apply(state,{type:'resume'}));document.querySelector('#restart').onclick=async()=>{await clear();commit(apply(state,{type:'restart'}));};
(async()=>{const saved=await load();if(saved)state=saved;draw();screen.toggleAttribute('hidden',!state.paused)})();
setInterval(()=>{screen.toggleAttribute('hidden',!state.paused)},50);addEventListener('pagehide',()=>void saving.then(()=>save(state)));
