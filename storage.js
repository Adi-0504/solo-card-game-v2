import {validateState} from './game.js';
const DB='solo-table-v2',STORE='state',KEY='current';
function db(){return new Promise((res,rej)=>{const r=indexedDB.open(DB,1);r.onupgradeneeded=()=>r.result.createObjectStore(STORE);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
export async function save(s){const d=await db();await new Promise((res,rej)=>{const t=d.transaction(STORE,'readwrite');t.objectStore(STORE).put(s,KEY);t.oncomplete=res;t.onerror=()=>rej(t.error)});d.close()}
export async function load(){try{const d=await db();const v=await new Promise((res,rej)=>{const r=d.transaction(STORE).objectStore(STORE).get(KEY);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});d.close();return validateState(v)?v:null}catch{return null}}
export async function clear(){try{const d=await db();d.transaction(STORE,'readwrite').objectStore(STORE).delete(KEY);d.close()}catch{}}
