
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = new Map();

const COLORS = {
  red:{name:"Kırmızı",need:3},
  blue:{name:"Mavi",need:3},
  green:{name:"Yeşil",need:3},
  yellow:{name:"Sarı",need:2},
  purple:{name:"Mor",need:2}
};

function shuffle(a){
  a=[...a];
  for(let i=a.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

function makeDeck(){
  const deck=[];
  let id=1;
  const add=(card,n=1)=>{ for(let i=0;i<n;i++) deck.push({...card,id:id++}); };

  Object.entries(COLORS).forEach(([color,m])=>{
    add({type:"property",name:`${m.name} Mülk`,color,value:2},m.need+2);
  });

  add({type:"money",name:"1M",value:1},8);
  add({type:"money",name:"2M",value:2},7);
  add({type:"money",name:"3M",value:3},5);
  add({type:"money",name:"5M",value:5},3);

  add({type:"action",action:"draw3",name:"3 Kart Çek",value:1},5);
  add({type:"action",action:"rent",name:"Kira Topla",value:1},8);
  add({type:"action",action:"steal",name:"Mülk Kap",value:3},4);

  return shuffle(deck);
}

function code(){
  const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s="";
  for(let i=0;i<5;i++) s+=chars[Math.floor(Math.random()*chars.length)];
  return s;
}

function emptyProperties(){
  return {red:[],blue:[],green:[],yellow:[],purple:[]};
}

function draw(room, player, n){
  for(let i=0;i<n;i++){
    if(!room.deck.length) break;
    player.hand.push(room.deck.pop());
  }
}

function completeSets(p){
  return Object.entries(COLORS).filter(([c,m])=>p.properties[c].length>=m.need).length;
}

function bankValue(p){
  return p.bank.reduce((s,c)=>s+c.value,0);
}

function publicState(room, viewerId){
  return {
    code: room.code,
    started: room.started,
    hostId: room.hostId,
    currentIndex: room.currentIndex,
    drawn: room.drawn,
    plays: room.plays,
    winnerId: room.winnerId || null,
    colors: COLORS,
    players: room.players.map((p,i)=>({
      id:p.id,
      name:p.name,
      handCount:p.hand.length,
      hand:p.id===viewerId ? p.hand : [],
      bankValue:bankValue(p),
      bankCount:p.bank.length,
      properties:Object.fromEntries(
        Object.entries(p.properties).map(([c,arr])=>[c,arr.length])
      ),
      completeSets:completeSets(p),
      isCurrent:i===room.currentIndex
    })),
    deckCount:room.deck.length,
    logs:room.logs.slice(-30).reverse()
  };
}

function emitRoom(room){
  room.players.forEach(p=>{
    io.to(p.id).emit("state",publicState(room,p.id));
  });
}

function log(room,msg){
  room.logs.push(msg);
}

function roomBySocket(socket){
  const code=socket.data.roomCode;
  return code ? rooms.get(code) : null;
}

function currentPlayer(room){
  return room.players[room.currentIndex];
}

function pay(from,to,amount){
  let remain=amount;
  from.bank.sort((a,b)=>a.value-b.value);

  while(remain>0 && from.bank.length){
    const card=from.bank.pop();
    to.bank.push(card);
    remain-=card.value;
  }

  if(remain>0){
    for(const c of Object.keys(COLORS)){
      while(remain>0 && from.properties[c].length){
        const card=from.properties[c].pop();
        to.properties[c].push(card);
        remain-=card.value;
      }
    }
  }
}

io.on("connection", socket=>{
  socket.on("createRoom", ({name})=>{
    let roomCode=code();
    while(rooms.has(roomCode)) roomCode=code();

    const room={
      code:roomCode,
      hostId:socket.id,
      players:[{id:socket.id,name:name||"Oyuncu 1",hand:[],bank:[],properties:emptyProperties()}],
      started:false,
      deck:[],
      currentIndex:0,
      drawn:false,
      plays:0,
      winnerId:null,
      logs:["Oda oluşturuldu."]
    };

    rooms.set(roomCode,room);
    socket.data.roomCode=roomCode;
    socket.join(roomCode);
    emitRoom(room);
  });

  socket.on("joinRoom", ({code:roomCode,name})=>{
    roomCode=String(roomCode||"").trim().toUpperCase();
    const room=rooms.get(roomCode);
    if(!room) return socket.emit("errorMsg","Oda bulunamadı.");
    if(room.started) return socket.emit("errorMsg","Oyun zaten başladı.");
    if(room.players.length>=4) return socket.emit("errorMsg","Oda dolu.");

    room.players.push({
      id:socket.id,
      name:name||`Oyuncu ${room.players.length+1}`,
      hand:[],bank:[],properties:emptyProperties()
    });
    socket.data.roomCode=roomCode;
    socket.join(roomCode);
    log(room,`${name||"Yeni oyuncu"} odaya katıldı.`);
    emitRoom(room);
  });

  socket.on("startGame", ()=>{
    const room=roomBySocket(socket);
    if(!room || room.hostId!==socket.id) return;
    if(room.players.length<2) return socket.emit("errorMsg","En az 2 oyuncu gerekli.");

    room.deck=makeDeck();
    room.started=true;
    room.currentIndex=0;
    room.drawn=false;
    room.plays=0;
    room.winnerId=null;

    room.players.forEach(p=>{
      p.hand=[];
      p.bank=[];
      p.properties=emptyProperties();
      draw(room,p,5);
    });

    log(room,"Oyun başladı.");
    emitRoom(room);
  });

  socket.on("draw2", ()=>{
    const room=roomBySocket(socket);
    if(!room || !room.started || room.winnerId) return;
    const p=currentPlayer(room);
    if(!p || p.id!==socket.id) return socket.emit("errorMsg","Sıra sende değil.");
    if(room.drawn) return socket.emit("errorMsg","Bu tur kartlarını zaten çektin.");

    room.drawn=true;
    draw(room,p,2);
    log(room,`${p.name} 2 kart çekti.`);
    emitRoom(room);
  });

  socket.on("playCard", ({cardId,targetId,color})=>{
    const room=roomBySocket(socket);
    if(!room || !room.started || room.winnerId) return;
    const p=currentPlayer(room);
    if(!p || p.id!==socket.id) return socket.emit("errorMsg","Sıra sende değil.");
    if(!room.drawn) return socket.emit("errorMsg","Önce 2 kart çekmelisin.");
    if(room.plays>=3) return socket.emit("errorMsg","Bu tur en fazla 3 kart oynayabilirsin.");

    const ix=p.hand.findIndex(c=>c.id===cardId);
    if(ix<0) return;
    const card=p.hand[ix];

    if(card.type==="property"){
      p.hand.splice(ix,1);
      p.properties[card.color].push(card);
      room.plays++;
      log(room,`${p.name}, ${COLORS[card.color].name} mülk oynadı.`);
    } else if(card.type==="money"){
      p.hand.splice(ix,1);
      p.bank.push(card);
      room.plays++;
      log(room,`${p.name}, ${card.value}M bankaya koydu.`);
    } else if(card.action==="draw3"){
      p.hand.splice(ix,1);
      draw(room,p,3);
      room.plays++;
      log(room,`${p.name}, 3 kart çekti.`);
    } else if(card.action==="rent"){
      if(!targetId || !color) return socket.emit("errorMsg","Kira için hedef ve renk seç.");
      if(!p.properties[color] || p.properties[color].length===0)
        return socket.emit("errorMsg","Bu renkte mülkün yok.");
      const target=room.players.find(x=>x.id===targetId);
      if(!target || target.id===p.id) return;
      p.hand.splice(ix,1);
      const rent=Math.max(1,p.properties[color].length);
      pay(target,p,rent);
      room.plays++;
      log(room,`${p.name}, ${target.name} oyuncusundan ${rent}M kira aldı.`);
    } else if(card.action==="steal"){
      if(!targetId || !color) return socket.emit("errorMsg","Mülk almak için hedef ve renk seç.");
      const target=room.players.find(x=>x.id===targetId);
      if(!target || target.id===p.id) return;
      const need=COLORS[color].need;
      if(!target.properties[color] || target.properties[color].length===0)
        return socket.emit("errorMsg","Hedefte bu renkte mülk yok.");
      if(target.properties[color].length>=need)
        return socket.emit("errorMsg","Tamamlanmış setten mülk alınamaz.");
      p.hand.splice(ix,1);
      const stolen=target.properties[color].pop();
      p.properties[color].push(stolen);
      room.plays++;
      log(room,`${p.name}, ${target.name} oyuncusundan ${COLORS[color].name} mülk aldı.`);
    }

    if(completeSets(p)>=3){
      room.winnerId=p.id;
      log(room,`${p.name} oyunu kazandı.`);
    }

    emitRoom(room);
  });

  socket.on("endTurn", ()=>{
    const room=roomBySocket(socket);
    if(!room || !room.started || room.winnerId) return;
    const p=currentPlayer(room);
    if(!p || p.id!==socket.id) return socket.emit("errorMsg","Sıra sende değil.");
    if(!room.drawn) return socket.emit("errorMsg","Önce 2 kart çekmelisin.");

    room.currentIndex=(room.currentIndex+1)%room.players.length;
    room.drawn=false;
    room.plays=0;
    log(room,`Sıra ${currentPlayer(room).name} oyuncusunda.`);
    emitRoom(room);
  });

  socket.on("disconnect", ()=>{
    const room=roomBySocket(socket);
    if(!room) return;

    const i=room.players.findIndex(p=>p.id===socket.id);
    if(i>=0){
      const [left]=room.players.splice(i,1);
      log(room,`${left.name} oyundan ayrıldı.`);
    }

    if(room.players.length===0){
      rooms.delete(room.code);
      return;
    }

    if(room.hostId===socket.id) room.hostId=room.players[0].id;
    if(room.currentIndex>=room.players.length) room.currentIndex=0;
    emitRoom(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=>console.log(`Property Rush Online: http://localhost:${PORT}`));
