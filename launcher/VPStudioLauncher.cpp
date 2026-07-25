#include <windows.h>
#include <windowsx.h>
#include <shlobj.h>
#include <shellapi.h>
#include <commctrl.h>
#include <uxtheme.h>
#include <string>
#include <vector>

#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "msimg32.lib")

namespace {
constexpr int ID_LAUNCH=100, ID_MODE=101, ID_PATH=102, ID_BROWSE=103, ID_CLEAR=104,
              ID_AUTO=105, ID_STATUS=106, ID_OPEN=107, ID_MINIMIZE=108, ID_CLOSE=109, ID_TIMER_AUTO=501;
HWND gWnd{}, gMode{}, gPath{}, gAuto{}, gStatus{}, gLaunch{};
HBRUSH gBg{}, gPanel{}, gEdit{};
HFONT gTitle{}, gBody{}, gSmall{};
std::wstring gRoot, gIni;
bool gAutoPending=false;
int gCacheMode=0;
bool gAutoChecked=false; // <-- НАШЕ СОБСТВЕННОЕ СОСТОЯНИЕ ЧЕКБОКСА

std::wstring DirOf(std::wstring p){ auto n=p.find_last_of(L"\\/"); return n==std::wstring::npos?L".":p.substr(0,n); }
std::wstring Join(const std::wstring&a,const std::wstring&b){ if(a.empty())return b; return a+(a.back()==L'\\'?L"":L"\\")+b; }
bool Exists(const std::wstring&p){ return GetFileAttributesW(p.c_str())!=INVALID_FILE_ATTRIBUTES; }
void Mkdir(const std::wstring&p){ SHCreateDirectoryExW(nullptr,p.c_str(),nullptr); }
std::wstring IniGet(const wchar_t*k,const wchar_t*d=L""){ wchar_t b[2048]{}; GetPrivateProfileStringW(L"Launcher",k,d,b,2048,gIni.c_str()); return b; }
void IniSet(const wchar_t*k,const std::wstring&v){ WritePrivateProfileStringW(L"Launcher",k,v.c_str(),gIni.c_str()); }
void SetText(HWND h,const std::wstring&s){ SetWindowTextW(h,s.c_str()); }
std::wstring GetText(HWND h){ int n=GetWindowTextLengthW(h); std::wstring s(n+1,L'\0'); GetWindowTextW(h,s.data(),n+1); s.resize(n); return s; }

std::wstring RuntimePath(){
  std::vector<std::wstring> candidates={Join(gRoot,L"runtime\\VPStudioRuntime.exe"),Join(gRoot,L"VP Studio Runtime.exe"),Join(gRoot,L"neutralino-win_x64.exe")};
  auto saved=IniGet(L"Runtime",L""); if(!saved.empty()) candidates.insert(candidates.begin(),saved);
  for(auto&p:candidates) if(Exists(p)) return p;
  return candidates.front();
}
std::wstring CachePath(){
  int mode=gCacheMode;
  if(mode==1) return Join(gRoot,L"data\\cache");
  if(mode==2) return GetText(gPath);
  auto marker=IniGet(L"RamMarker",L"R:\\VP-RAM");
  if(Exists(marker)) return Join(marker,L"WebView2");
  return Join(gRoot,L"data\\cache");
}
void UpdateStatus(){
  auto runtime=RuntimePath(), cache=CachePath();
  std::wstring text=Exists(runtime)?L"[OK] Runtime found":L"[ERR] Runtime not found";
  text+=L"   |   Cache: "+cache;
  
  // Очищаем область перед установкой нового текста
  RECT rc; GetClientRect(gStatus, &rc);
  InvalidateRect(gStatus, &rc, TRUE);
  
  SetText(gStatus,text);
  EnableWindow(gLaunch,Exists(runtime));
}
void SaveSettings(){
  IniSet(L"CacheMode",std::to_wstring(gCacheMode));
  IniSet(L"CustomCache",GetText(gPath));
  IniSet(L"AutoLaunch",gAutoChecked?L"1":L"0"); // <-- ЧИТАЕМ ИЗ НАШЕЙ ПЕРЕМЕННОЙ
}
void LaunchStudio(){
  KillTimer(gWnd,ID_TIMER_AUTO); gAutoPending=false; SaveSettings();
  auto exe=RuntimePath(), cache=CachePath(); Mkdir(cache);
  SetEnvironmentVariableW(L"WEBVIEW2_USER_DATA_FOLDER",cache.c_str());
  std::wstring cmd=L"\""+exe+L"\""; STARTUPINFOW si{sizeof(si)}; PROCESS_INFORMATION pi{};
  std::vector<wchar_t> buf(cmd.begin(),cmd.end()); buf.push_back(0);
  if(CreateProcessW(exe.c_str(),buf.data(),nullptr,nullptr,FALSE,0,nullptr,gRoot.c_str(),&si,&pi)){
    CloseHandle(pi.hThread); CloseHandle(pi.hProcess); DestroyWindow(gWnd);
  } else MessageBoxW(gWnd,(L"Could not launch:\n"+exe).c_str(),L"VP Studio",MB_ICONERROR);
}
void Browse(){
  IFileDialog* dlg{}; if(FAILED(CoCreateInstance(CLSID_FileOpenDialog,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&dlg))))return;
  DWORD opts{}; dlg->GetOptions(&opts); dlg->SetOptions(opts|FOS_PICKFOLDERS|FOS_FORCEFILESYSTEM);
  if(SUCCEEDED(dlg->Show(gWnd))){ IShellItem* item{}; if(SUCCEEDED(dlg->GetResult(&item))){ PWSTR p{}; if(SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH,&p))){ SetText(gPath,p); CoTaskMemFree(p); gCacheMode=2;SetText(gMode,L"Custom folder   v"); UpdateStatus(); } item->Release(); }} dlg->Release();
}

void DrawRobot(HDC dc){
  HPEN glow = CreatePen(PS_SOLID, 3, RGB(126, 105, 255));
  HPEN oldP = (HPEN)SelectObject(dc, glow);
  HBRUSH body = CreateSolidBrush(RGB(43, 40, 72));
  HBRUSH oldB = (HBRUSH)SelectObject(dc, body);

  RoundRect(dc, 38, 44, 148, 145, 24, 24);
  
  HBRUSH screen = CreateSolidBrush(RGB(25, 23, 45));
  SelectObject(dc, screen);
  RoundRect(dc, 53, 59, 133, 112, 18, 18);

  HBRUSH eye = CreateSolidBrush(RGB(112, 229, 255));
  SelectObject(dc, eye);
  HPEN eyePen = CreatePen(PS_SOLID, 2, RGB(112, 229, 255));
  SelectObject(dc, eyePen);
  Ellipse(dc, 70, 77, 84, 91);
  Ellipse(dc, 103, 77, 117, 91);
  DeleteObject(eyePen);

  SelectObject(dc, glow);
  MoveToEx(dc, 93, 44, nullptr);
  LineTo(dc, 93, 27);
  HBRUSH antennaTip = CreateSolidBrush(RGB(112, 229, 255));
  SelectObject(dc, antennaTip);
  Ellipse(dc, 88, 20, 98, 30);

  MoveToEx(dc, 65, 126, nullptr); LineTo(dc, 53, 156);
  MoveToEx(dc, 121, 126, nullptr); LineTo(dc, 133, 156);

  HPEN basePen = CreatePen(PS_SOLID, 2, RGB(126, 105, 255));
  SelectObject(dc, basePen);
  MoveToEx(dc, 40, 160, nullptr); LineTo(dc, 146, 160);

  DeleteObject(antennaTip);
  DeleteObject(basePen);
  DeleteObject(eye);
  SelectObject(dc, oldB); SelectObject(dc, oldP);
  DeleteObject(screen);
  DeleteObject(body);
  DeleteObject(glow);
}

void FillGradient(HDC dc,const RECT&r,COLORREF top,COLORREF bottom){
  TRIVERTEX v[2]={{r.left,r.top,(COLOR16)(GetRValue(top)<<8),(COLOR16)(GetGValue(top)<<8),(COLOR16)(GetBValue(top)<<8),0xff00},
                  {r.right,r.bottom,(COLOR16)(GetRValue(bottom)<<8),(COLOR16)(GetGValue(bottom)<<8),(COLOR16)(GetBValue(bottom)<<8),0xff00}};
  GRADIENT_RECT gr{0,1};GradientFill(dc,v,2,&gr,1,GRADIENT_FILL_RECT_V);
}

void DrawOwnerButton(const DRAWITEMSTRUCT* di){
  bool down=(di->itemState&ODS_SELECTED)!=0, disabled=(di->itemState&ODS_DISABLED)!=0;
  RECT r=di->rcItem; 
  
  HBRUSH clear=CreateSolidBrush(RGB(30,30,46));
  FillRect(di->hDC,&r,clear);DeleteObject(clear);

  if(di->CtlID==ID_AUTO){
    RECT box{r.left, r.top+6, r.left+18, r.top+24};
    
    HBRUSH bb=CreateSolidBrush(RGB(37,37,64));
    FillRect(di->hDC,&box,bb);DeleteObject(bb);
    
    HPEN bp=CreatePen(PS_SOLID, 2, RGB(108,95,166));
    HPEN oldp=(HPEN)SelectObject(di->hDC,bp);
    HBRUSH oldb=(HBRUSH)SelectObject(di->hDC,GetStockObject(NULL_BRUSH));
    RoundRect(di->hDC, box.left, box.top, box.right, box.bottom, 6, 6);
    SelectObject(di->hDC, oldb);
    SelectObject(di->hDC, oldp);
    DeleteObject(bp);
    
    if(gAutoChecked){ // <-- ЧИТАЕМ ИЗ НАШЕЙ ПЕРЕМЕННОЙ
      HPEN cp=CreatePen(PS_SOLID, 3, RGB(137,220,170));
      oldp=(HPEN)SelectObject(di->hDC,cp);
      MoveToEx(di->hDC, box.left+4, box.top+9, nullptr);
      LineTo(di->hDC, box.left+8, box.top+14);
      LineTo(di->hDC, box.left+14, box.top+5);
      SelectObject(di->hDC,oldp);
      DeleteObject(cp);
    }
    
    SetBkMode(di->hDC,TRANSPARENT);
    SetTextColor(di->hDC,RGB(205,214,244));
    SelectObject(di->hDC,gBody);
    RECT tr{r.left+28, r.top, r.right, r.bottom};
    DrawTextW(di->hDC,L"Quick launch next time",-1,&tr,DT_LEFT|DT_VCENTER|DT_SINGLELINE);
    
    return;
  }

  COLORREF top,bottom,border;
  if(di->CtlID==ID_LAUNCH){
    top=down?RGB(85,73,145):RGB(124,108,184);
    bottom=down?RGB(65,56,112):RGB(88,75,145);
    border=RGB(151,137,213);
  } else if(di->CtlID==ID_CLOSE){
    top=down?RGB(125,45,62):RGB(64,46,69);
    bottom=RGB(38,32,52);
    border=RGB(92,72,110);
  } else {
    top=down?RGB(45,43,76):RGB(49,48,82);
    bottom=down?RGB(31,30,54):RGB(35,34,61);
    border=RGB(75,72,120);
  }
  
  int saved=SaveDC(di->hDC);
  HRGN clip=CreateRoundRectRgn(r.left,r.top,r.right+1,r.bottom+1,9,9);
  SelectClipRgn(di->hDC,clip);
  FillGradient(di->hDC,r,top,bottom);
  SelectClipRgn(di->hDC,nullptr);
  DeleteObject(clip);
  RestoreDC(di->hDC,saved);
  
  HPEN pen=CreatePen(PS_SOLID,1,border),oldP=(HPEN)SelectObject(di->hDC,pen);
  HBRUSH hollow=(HBRUSH)GetStockObject(NULL_BRUSH),oldB=(HBRUSH)SelectObject(di->hDC,hollow);
  RoundRect(di->hDC,r.left,r.top,r.right-1,r.bottom-1,9,9);
  SelectObject(di->hDC,oldB);SelectObject(di->hDC,oldP);DeleteObject(pen);
  
  HPEN shine=CreatePen(PS_SOLID,1,RGB(112,105,150));
  oldP=(HPEN)SelectObject(di->hDC,shine);
  MoveToEx(di->hDC,r.left+8,r.top+2,nullptr);
  LineTo(di->hDC,r.right-8,r.top+2);
  SelectObject(di->hDC,oldP);DeleteObject(shine);
  
  wchar_t text[256]{};GetWindowTextW(di->hwndItem,text,256);
  SetBkMode(di->hDC,TRANSPARENT);
  SetTextColor(di->hDC,disabled?RGB(100,100,120):RGB(205,214,244));
  SelectObject(di->hDC,gBody);
  DrawTextW(di->hDC,text,-1,&r,DT_CENTER|DT_VCENTER|DT_SINGLELINE);
}

HWND Make(const wchar_t*cls,const wchar_t*txt,DWORD style,int x,int y,int w,int h,int id=0){
  if(lstrcmpiW(cls,L"BUTTON")==0) style=(style&~BS_TYPEMASK)|BS_OWNERDRAW;
  HWND c=CreateWindowExW(0,cls,txt,WS_CHILD|WS_VISIBLE|style,x,y,w,h,gWnd,(HMENU)(INT_PTR)id,GetModuleHandleW(nullptr),nullptr);
  SendMessageW(c,WM_SETFONT,(WPARAM)gBody,TRUE); return c;
}

LRESULT CALLBACK Proc(HWND w,UINT m,WPARAM wp,LPARAM lp){
 switch(m){
  case WM_CREATE:{
   gWnd=w;
   Make(L"BUTTON",L"_",WS_TABSTOP,591,4,34,28,ID_MINIMIZE);
   Make(L"BUTTON",L"X",WS_TABSTOP,629,4,34,28,ID_CLOSE);
   gTitle=CreateFontW(30,0,0,0,FW_BOLD,0,0,0,DEFAULT_CHARSET,0,0,CLEARTYPE_QUALITY,0,L"Segoe UI");
   gBody=CreateFontW(17,0,0,0,FW_NORMAL,0,0,0,DEFAULT_CHARSET,0,0,CLEARTYPE_QUALITY,0,L"Segoe UI");
   gSmall=CreateFontW(14,0,0,0,FW_NORMAL,0,0,0,DEFAULT_CHARSET,0,0,CLEARTYPE_QUALITY,0,L"Segoe UI");
   
   auto title=Make(L"STATIC",L"VP Studio",0,178,40,360,42); SendMessageW(title,WM_SETFONT,(WPARAM)gTitle,TRUE);
   auto sub=Make(L"STATIC",L"Local Creative Studio",0,180,82,360,24); SendMessageW(sub,WM_SETFONT,(WPARAM)gSmall,TRUE);
   Make(L"STATIC",L"WebView2 Cache",0,42,185,180,24);
   
   gCacheMode=_wtoi(IniGet(L"CacheMode",L"0").c_str());if(gCacheMode<0||gCacheMode>2)gCacheMode=0;
   const wchar_t* modes[]={L"Auto: RAM disk -> local folder   v",L"Always use local folder   v",L"Custom folder   v"};
   gMode=Make(L"BUTTON",modes[gCacheMode],WS_TABSTOP,42,213,300,30,ID_MODE);
   
   gPath=Make(L"EDIT",IniGet(L"CustomCache",Join(gRoot,L"data\\cache").c_str()).c_str(), ES_AUTOHSCROLL|WS_TABSTOP,42,258,430,32,ID_PATH);
   Make(L"BUTTON",L"Browse...",WS_TABSTOP,482,258,94,32,ID_BROWSE);
   
   // <-- БЕЗ BS_AUTOCHECKBOX — управляем состоянием сами
   gAuto=Make(L"BUTTON",L"Quick launch next time",WS_TABSTOP,42,315,340,28,ID_AUTO);
   gAutoChecked = (IniGet(L"AutoLaunch",L"0")==L"1"); // <-- ЧИТАЕМ ИЗ INI В НАШУ ПЕРЕМЕННУЮ
   
   gStatus=Make(L"STATIC",L"",0,42,370,535,42,ID_STATUS); SendMessageW(gStatus,WM_SETFONT,(WPARAM)gSmall,TRUE);
   gLaunch=Make(L"BUTTON",L">  Launch VP Studio",BS_DEFPUSHBUTTON|WS_TABSTOP,42,430,300,48,ID_LAUNCH);
   Make(L"BUTTON",L"Clear cache",WS_TABSTOP,355,430,130,48,ID_CLEAR);
   Make(L"BUTTON",L"Open folder",WS_TABSTOP,495,430,120,48,ID_OPEN);
   
   UpdateStatus();
	// Автозапуск теперь управляется из wWinMain, чтобы окно вообще не показывалось
   return 0;
  }
  case WM_LBUTTONDOWN: 
    if(gAutoPending){KillTimer(w,ID_TIMER_AUTO);gAutoPending=false;UpdateStatus();} 
    break;
  case WM_TIMER: 
    if(wp==ID_TIMER_AUTO) LaunchStudio(); 
    return 0;
  case WM_COMMAND:{ 
    int id=LOWORD(wp), code=HIWORD(wp);
    if(id==ID_LAUNCH) LaunchStudio(); 
    else if(id==ID_BROWSE) Browse();
    else if(id==ID_MINIMIZE) ShowWindow(w,SW_MINIMIZE); 
    else if(id==ID_CLOSE) DestroyWindow(w);
    else if(id==ID_MODE){
      gCacheMode=(gCacheMode+1)%3;
      const wchar_t* modes[]={L"Auto: RAM disk -> local folder   v",L"Always use local folder   v",L"Custom folder   v"};
      SetText(gMode,modes[gCacheMode]);
      UpdateStatus();
    }
    else if(id==ID_AUTO){
      gAutoChecked = !gAutoChecked; // <-- ПЕРЕКЛЮЧАЕМ НАШУ ПЕРЕМЕННУЮ
      InvalidateRect(gAuto, nullptr, TRUE);
      SaveSettings();
    }
    else if(id==ID_PATH && code==EN_CHANGE) UpdateStatus();
    else if(id==ID_OPEN){
      auto p=CachePath();Mkdir(p);ShellExecuteW(w,L"open",p.c_str(),nullptr,nullptr,SW_SHOWNORMAL);
    }
    else if(id==ID_CLEAR){
      auto p=CachePath(); 
      if(MessageBoxW(w,(L"Clear temporary cache?\n"+p).c_str(),L"VP Studio",MB_YESNO|MB_ICONQUESTION)==IDYES){ 
        SHFILEOPSTRUCTW op{}; std::wstring from=p; from.push_back(L'\0'); from.push_back(L'\0'); 
        op.wFunc=FO_DELETE;op.pFrom=from.c_str();op.fFlags=FOF_NOCONFIRMATION|FOF_NOERRORUI|FOF_SILENT;
        SHFileOperationW(&op);Mkdir(p);UpdateStatus();
      }
    }
    return 0;
  }
  case WM_DRAWITEM: 
    DrawOwnerButton((DRAWITEMSTRUCT*)lp); 
    return TRUE;
  case WM_NCHITTEST:{ 
    POINT p{GET_X_LPARAM(lp),GET_Y_LPARAM(lp)};
    ScreenToClient(w,&p); 
    if(p.y<36 && p.x<580) return HTCAPTION; 
    return HTCLIENT; 
  }
  case WM_ERASEBKGND:
    return 1;
  case WM_CTLCOLORSTATIC:{
    HDC hdcStatic = (HDC)wp;
    SetTextColor(hdcStatic, RGB(205,214,244));
    SetBkMode(hdcStatic, TRANSPARENT);
  
  // Для статуса используем тот же фон что и у панели
    if((HWND)lp == gStatus){
      return (LRESULT)gPanel;
    }
  
  return (LRESULT)GetStockObject(NULL_BRUSH);
}
  case WM_CTLCOLOREDIT:{
    if((HWND)lp == gPath){
      SetTextColor((HDC)wp, RGB(238,237,250));
      SetBkColor((HDC)wp, RGB(37,37,64));
      return (LRESULT)gEdit;
    }
    return (LRESULT)GetStockObject(NULL_BRUSH);
  }
  case WM_PAINT:{
    PAINTSTRUCT ps{};
    auto dc=BeginPaint(w,&ps);
    RECT r{};GetClientRect(w,&r);
    FillRect(dc,&r,gBg);
    
    HBRUSH header=CreateSolidBrush(RGB(30,30,46));
    RECT hr{0,0,r.right,36};
    FillRect(dc,&hr,header);DeleteObject(header);
    
    HPEN line=CreatePen(PS_SOLID,1,RGB(56,56,96)),old=(HPEN)SelectObject(dc,line);
    MoveToEx(dc,0,35,nullptr);LineTo(dc,r.right,35);
    SelectObject(dc,old);DeleteObject(line);
    
    SetBkMode(dc,TRANSPARENT);SetTextColor(dc,RGB(166,173,200));
    SelectObject(dc,gSmall);
    RECT cap{14,0,400,36};
    DrawTextW(dc,L"VP Studio Launcher",-1,&cap,DT_LEFT|DT_VCENTER|DT_SINGLELINE);
    
    RECT panel{22,165,635,500};
    FillRect(dc,&panel,gPanel);
    DrawRobot(dc);
    
    EndPaint(w,&ps);
    return 0;
  }
  case WM_DESTROY: 
    SaveSettings(); 
    DeleteObject(gTitle);DeleteObject(gBody);DeleteObject(gSmall);
    DeleteObject(gBg);DeleteObject(gPanel);DeleteObject(gEdit);
    PostQuitMessage(0);
    return 0;
 }
 return DefWindowProcW(w,m,wp,lp);
}
}

int WINAPI wWinMain(HINSTANCE hi,HINSTANCE,LPWSTR,int){
 CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED); 
 INITCOMMONCONTROLSEX ic{sizeof(ic),ICC_STANDARD_CLASSES};
 InitCommonControlsEx(&ic);
 
 wchar_t exe[MAX_PATH]{};
 GetModuleFileNameW(nullptr,exe,MAX_PATH);
 gRoot=DirOf(exe);
 gIni=Join(gRoot,L"launcher.ini");
 
 gBg=CreateSolidBrush(RGB(17,17,27));
 gPanel=CreateSolidBrush(RGB(30,30,46));
 gEdit=CreateSolidBrush(RGB(37,37,64));
 
 WNDCLASSEXW wc{sizeof(wc)};
 wc.hInstance=hi;
 wc.lpfnWndProc=Proc;
 wc.lpszClassName=L"VPStudioLauncherWindow";
 wc.hCursor=LoadCursor(nullptr,IDC_ARROW);
 wc.hIcon=LoadIcon(nullptr,IDI_APPLICATION);
 wc.hbrBackground=gBg;
 RegisterClassExW(&wc);
 
 HWND w=CreateWindowExW(0,wc.lpszClassName,L"VP Studio Launcher",WS_POPUP|WS_MINIMIZEBOX,CW_USEDEFAULT,CW_USEDEFAULT,675,555,nullptr,nullptr,hi,nullptr);
 if(!w)return 1;
 
 RECT wr{};GetWindowRect(w,&wr);
 int ww=wr.right-wr.left,wh=wr.bottom-wr.top;
 RECT work{};SystemParametersInfoW(SPI_GETWORKAREA,0,&work,0);
 SetWindowPos(w,nullptr,work.left+(work.right-work.left-ww)/2,work.top+(work.bottom-work.top-wh)/2,0,0,SWP_NOSIZE|SWP_NOZORDER);
 
 HRGN region=CreateRoundRectRgn(0,0,ww+1,wh+1,14,14);
 SetWindowRgn(w,region,TRUE);
 
 if(gAutoChecked){
   // Если стоит галка — сразу запускаем студию, окно не показываем
   LaunchStudio();
 } else {
   ShowWindow(w,SW_SHOW);
   UpdateWindow(w);
 }
 
 MSG msg{};
 while(GetMessageW(&msg,nullptr,0,0)>0){
   TranslateMessage(&msg);
   DispatchMessageW(&msg);
 }
 
 CoUninitialize();
 return (int)msg.wParam;
}