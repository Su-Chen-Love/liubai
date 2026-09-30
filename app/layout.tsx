import type {Metadata,Viewport} from 'next';
import './globals.css';
export const metadata:Metadata={title:'留白 · 让重要的事有位置',description:'用四象限、时间层级与轻盈的交互，整理任务，也整理思绪。',manifest:'/manifest.webmanifest',applicationName:'留白',appleWebApp:{capable:true,title:'留白',statusBarStyle:'default'},icons:{icon:[{url:'/favicon.svg',type:'image/svg+xml'},{url:'/icon-192.png',sizes:'192x192',type:'image/png'}],apple:[{url:'/apple-touch-icon.png',sizes:'180x180',type:'image/png'}]}};
export const viewport:Viewport={width:'device-width',initialScale:1,viewportFit:'cover',themeColor:'#f3f6f4'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="zh-CN"><body>{children}</body></html>}
