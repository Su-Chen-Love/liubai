import type { Metadata } from 'next';
import './globals.css';
export const metadata:Metadata={title:'留白 · 让重要的事有位置',description:'用四象限、时间层级与轻盈的交互，整理任务，也整理思绪。',icons:{icon:'/favicon.svg'}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="zh-CN"><body>{children}</body></html>}
