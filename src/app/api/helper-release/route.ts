import { publicFetch } from '@/server/upstream';
export const runtime='nodejs';
let cached:{expires:number;assets:string[]}|undefined;
export async function GET(){
  try{
    if(!cached || cached.expires<Date.now()){
      const response=await publicFetch('https://api.github.com/repos/cristonj/MusicDownloader/releases/tags/helper-v1',{headers:{Accept:'application/vnd.github+json','User-Agent':'MusicDownloader'},signal:AbortSignal.timeout(8000)});
      const release=response.ok?await response.json():null;
      cached={expires:Date.now()+15000,assets:(release?.assets||[]).filter((asset:{state:string;size:number})=>asset.state==='uploaded'&&asset.size>0).map((asset:{name:string})=>asset.name)};
    }
    return Response.json({windows:cached.assets.includes('MusicDownloader-Helper-Windows-Setup.exe'),windowsPortable:cached.assets.includes('MusicDownloader-Helper-Windows.exe'),mac:cached.assets.includes('MusicDownloader-Helper-Mac.zip'),linux:cached.assets.includes('MusicDownloader-Helper-Linux.tar.gz')},{headers:{'Cache-Control':'public, max-age=10'}});
  }catch{return Response.json({windows:false,mac:false,linux:false},{headers:{'Cache-Control':'no-store'}});}
}
