export const SUITS=['cross','triangle','square','diamond'];
export const VERSION=2, HAND_SIZE=13, MIN_GROUP=4;
const next=n=>n===13?1:n+1;
export const isConsecutive=(a,b)=>b===next(a);
export class RNG{constructor(state){this.state=(state>>>0)||0x9e3779b9}next(){let x=this.state;x^=x<<13;x^=x>>>17;x^=x<<5;this.state=x>>>0;return this.state/4294967296}card(){return {id:crypto.randomUUID(),number:this.int(13)+1,suit:SUITS[this.int(4)]}}int(n){return Math.floor(this.next()*n)}}
export function createState(seed=Math.floor(Math.random()*0xffffffff)){const r=new RNG(seed);const hand=Array.from({length:HAND_SIZE},()=>r.card());return {version:VERSION,seed,rngState:r.state,hand,table:[],completed:[],turn:0,phase:'playing',paused:false}}
export function validateCard(c){return !!c&&typeof c.id==='string'&&Number.isInteger(c.number)&&c.number>=1&&c.number<=13&&SUITS.includes(c.suit)}
export function validateState(s){return !!s&&s.version===VERSION&&Number.isInteger(s.rngState)&&Array.isArray(s.hand)&&s.hand.length===HAND_SIZE&&s.hand.every(validateCard)&&Array.isArray(s.table)&&s.table.every(validateCard)&&Array.isArray(s.completed)&&s.completed.every(g=>Array.isArray(g)&&g.every(validateCard))&&Number.isInteger(s.turn)&&s.turn>=0&&['playing'].includes(s.phase)&&typeof s.paused==='boolean'}
export function cloneState(s){return structuredClone(s)}
function groupAt(row,i){let end=i;while(end+1<row.length&&isConsecutive(row[end].number,row[end+1].number))end++;if(end-i+1<MIN_GROUP)return null;const cards=row.slice(i,end+1);const same=cards.every(c=>c.suit===cards[0].suit);return {start:i,end,cards,sameSuit:same,rule:same?'B':'A'}}
export function findCompleted(row){for(let i=0;i<row.length;i++){if(i&&isConsecutive(row[i-1].number,row[i].number))continue;const g=groupAt(row,i);if(g)return g}return null}
export function apply(state,action){if(action.type==='pause')return {...state,paused:true};if(action.type==='resume')return {...state,paused:false};if(action.type==='restart')return createState();if(state.paused)return state;if(action.type!=='play')return state;const hi=state.hand.findIndex(c=>c.id===action.cardId);if(hi<0||action.index<0||action.index>state.table.length)return state;const nextState=cloneState(state);const [card]=nextState.hand.splice(hi,1);nextState.table.splice(action.index,0,card);const r=new RNG(nextState.rngState);nextState.hand.push(r.card());nextState.rngState=r.state;nextState.turn++;
const g=findCompleted(nextState.table);if(g){nextState.completed.push(g.cards);/* Rule resolution intentionally does not remove or move cards. */}
return nextState}
