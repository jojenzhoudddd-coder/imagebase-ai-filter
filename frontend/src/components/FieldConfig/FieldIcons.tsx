// SVG field type icons matching Lark Base style
// 16×16 viewBox, stroke-based, 1.5px stroke

import { FieldType } from "../../types";

interface IconProps {
  size?: number;
  className?: string;
}

const s = { strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, fill: "none", stroke: "currentColor" };

const ICONS: Record<string, (p: IconProps) => JSX.Element> = {
  // ── Basic ──
  Text: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}><path d="M14.0662 20.357L12.0178 14.9997L12.0002 14.9999H5.00024L4.9827 14.9997L2.93432 20.357C2.73708 20.8729 2.159 21.1312 1.64313 20.9339C1.12727 20.7367 0.868976 20.1586 1.06622 19.6427L7.09919 3.8642C7.59079 2.57847 9.40975 2.57847 9.90135 3.8642L15.9343 19.6427C16.1316 20.1586 15.8733 20.7367 15.3574 20.9339C14.8415 21.1312 14.2635 20.8729 14.0662 20.357ZM8.50027 5.79992L5.74735 12.9999H11.2532L8.50027 5.79992Z" fill="currentColor"/><path d="M19.9365 13.1024C19.3493 13.1024 18.7804 13.3072 18.328 13.6816L18.0368 13.9226C17.6539 14.2395 17.0865 14.186 16.7696 13.803C16.4527 13.4201 16.5063 12.8528 16.8892 12.5359L17.1804 12.2949C17.9556 11.6534 18.9303 11.3024 19.9366 11.3024L20.2637 11.3024C21.7603 11.3024 23.0616 12.329 23.4099 13.7845C23.4737 14.051 23.5058 14.3241 23.5057 14.5982L23.5025 20.1004C23.5022 20.5975 23.099 21.0002 22.602 20.9999C22.1049 20.9996 21.7022 20.5964 21.7025 20.0994L21.7026 19.969C21.0846 20.3707 20.3472 20.6041 19.5552 20.6041H19.0219C17.6292 20.6041 16.5002 19.4751 16.5002 18.0824C16.5002 16.4375 17.8337 15.1041 19.4786 15.1041H21.7054L21.7057 14.5971C21.7058 14.4645 21.6902 14.3324 21.6594 14.2035C21.5048 13.5578 20.9276 13.1024 20.2637 13.1024L19.9365 13.1024ZM21.6864 16.9041H19.4786C18.8278 16.9041 18.3002 17.4316 18.3002 18.0824C18.3002 18.481 18.6233 18.8041 19.0219 18.8041H19.5552C20.657 18.8041 21.5648 17.9734 21.6864 16.9041Z" fill="currentColor"/></svg>
  ),
  Number: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className}><path d="M5.5 2.5l-1 11M11.5 2.5l-1 11M2 6h12M2 10h12" {...s}/></svg>
  ),
  SingleSelect: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}><path d="M7.75532 11.6577C7.36632 11.2661 7.36663 10.6328 7.75691 10.2425C8.14719 9.85219 8.78053 9.85188 9.17082 10.2422L11.9997 13.0711L14.8283 10.2425C15.2187 9.85208 15.8518 9.8524 16.2422 10.2428C16.6326 10.6332 16.6329 11.2663 16.2438 11.658C15.0626 12.847 13.8877 14.0436 12.6914 15.2173C12.307 15.5944 11.6925 15.5944 11.308 15.2173C10.1116 14.0435 8.93661 12.8468 7.75532 11.6577Z" fill="currentColor"/><path d="M12 23C5.92487 23 1 18.0751 1 12C1 5.92487 5.92487 1 12 1C18.0751 1 23 5.92487 23 12C23 18.0751 18.0751 23 12 23ZM12 21C16.9706 21 21 16.9706 21 12C21 7.02944 16.9706 3 12 3C7.02944 3 3 7.02944 3 12C3 16.9706 7.02944 21 12 21Z" fill="currentColor"/></svg>
  ),
  MultiSelect: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}><path d="M12 21C16.9705 21 21 16.9705 21 12C21 7.0295 16.9705 3 12 3C7.0295 3 3 7.0295 3 12C3 16.9705 7.0295 21 12 21ZM12 23C5.925 23 1 18.075 1 12C1 5.925 5.925 1 12 1C18.075 1 23 5.925 23 12C23 18.075 18.075 23 12 23Z" fill="currentColor"/><path d="M8.5 12C8.5 12.8284 7.82843 13.5 7 13.5C6.17157 13.5 5.5 12.8284 5.5 12C5.5 11.1716 6.17157 10.5 7 10.5C7.82843 10.5 8.5 11.1716 8.5 12Z" fill="currentColor"/><path d="M18.5 12C18.5 12.8284 17.8284 13.5 17 13.5C16.1716 13.5 15.5 12.8284 15.5 12C15.5 11.1716 16.1716 10.5 17 10.5C17.8284 10.5 18.5 11.1716 18.5 12Z" fill="currentColor"/><path d="M13.5 12C13.5 12.8284 12.8284 13.5 12 13.5C11.1716 13.5 10.5 12.8284 10.5 12C10.5 11.1716 11.1716 10.5 12 10.5C12.8284 10.5 13.5 11.1716 13.5 12Z" fill="currentColor"/></svg>
  ),
  User: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}><path d="M15 6.5C15 4.84315 13.6569 3.5 12 3.5C10.3431 3.5 9 4.84315 9 6.5C9 8.15685 10.3431 9.5 12 9.5C13.6569 9.5 15 8.15685 15 6.5ZM17 6.5C17 9.26142 14.7614 11.5 12 11.5C9.23858 11.5 7 9.26142 7 6.5C7 3.73858 9.23858 1.5 12 1.5C14.7614 1.5 17 3.73858 17 6.5ZM4 19V21H20V19C20 16.7909 18.2091 15 16 15H8C5.79086 15 4 16.7909 4 19ZM2 19C2 15.6863 4.68629 13 8 13H16C19.3137 13 22 15.6863 22 19V21C22 22.1046 21.1046 23 20 23H4C2.89543 23 2 22.1046 2 21V19Z" fill="currentColor"/></svg>
  ),
  DateTime: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}><path d="M7 2C7.55228 2 8 2.44772 8 3H16C16 2.44772 16.4477 2 17 2C17.5523 2 18 2.44772 18 3C18.4142 3 19.2197 3 20 3C21.1046 3 22 3.89543 22 5V20C22 21.1046 21.1046 22 20 22H4C2.89543 22 2 21.1046 2 20L2 5C2 3.89543 2.8954 3 3.99997 3C4.78026 3 5.58581 3 6 3C6 2.44772 6.44772 2 7 2ZM16 5H8C8 5.55228 7.55228 6 7 6C6.44772 6 6 5.55228 6 5H4V20H20V5H18C18 5.55228 17.5523 6 17 6C16.4477 6 16 5.55228 16 5ZM9 15C9 14.4477 8.55228 14 8 14H7C6.44772 14 6 14.4477 6 15V16C6 16.5523 6.44772 17 7 17H8C8.55228 17 9 16.5523 9 16V15ZM10.5 10C10.5 9.44772 10.9477 9 11.5 9H12.5C13.0523 9 13.5 9.44772 13.5 10V11C13.5 11.5523 13.0523 12 12.5 12H11.5C10.9477 12 10.5 11.5523 10.5 11V10ZM13.5 15C13.5 14.4477 13.0523 14 12.5 14H11.5C10.9477 14 10.5 14.4477 10.5 15V16C10.5 16.5523 10.9477 17 11.5 17H12.5C13.0523 17 13.5 16.5523 13.5 16V15ZM15 15C15 14.4477 15.4477 14 16 14H17C17.5523 14 18 14.4477 18 15V16C18 16.5523 17.5523 17 17 17H16C15.4477 17 15 16.5523 15 16V15ZM18 10C18 9.44772 17.5523 9 17 9H16C15.4477 9 15 9.44772 15 10V11C15 11.5523 15.4477 12 16 12H17C17.5523 12 18 11.5523 18 11V10Z" fill="currentColor"/></svg>
  ),
  Attachment: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className}><path d="M13.5 7.5l-5.3 5.3a3 3 0 01-4.2-4.2l5.3-5.3a2 2 0 012.8 2.8L6.8 11.4a1 1 0 01-1.4-1.4L10.7 4.7" {...s}/></svg>
  ),
  Checkbox: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className}><rect x="2.5" y="2.5" width="11" height="11" rx="2" {...s}/><path d="M5 8l2 2 4-4" {...s}/></svg>
  ),
  Stage: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className}><path d="M2 8h3l2-3 2 6 2-3h3" {...s}/></svg>
  ),
  AutoNumber: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}><path d="M0.982422 12C0.982422 11.4752 1.01917 10.9591 1.09023 10.4539L3.07097 10.7326C3.01261 11.1466 2.98242 11.5698 2.98242 12C2.98242 16.9706 7.01186 21 11.9824 21C12.7585 21 13.5116 20.9018 14.23 20.7171L14.7235 22.6557C13.8473 22.8805 12.9288 23 11.9824 23C5.90729 23 0.982422 18.0751 0.982422 12Z" fill="currentColor"/><path d="M22.9046 13.3156C22.956 12.8842 22.9824 12.4452 22.9824 12C22.9824 5.92487 18.0576 1 11.9824 1C10.7524 1 9.56946 1.2019 8.46504 1.57437L8.29137 3.78927C9.41767 3.28216 10.6671 3 11.9824 3C16.953 3 20.9824 7.02944 20.9824 12C20.9824 12.3621 20.961 12.7192 20.9195 13.0701L22.9046 13.3156Z" fill="currentColor"/><path d="M4.60172 9.74254H6.15962L6.714 2.3H5.36663C5.17271 3.0663 4.45524 3.65414 3.37999 3.67514L3.30102 4.73536H4.9747L4.60172 9.74254Z" fill="currentColor"/><path d="M8.93562 15.6687H14.3356L14.4349 14.3356H10.9191C11.0124 14.0732 11.2198 13.8317 11.5715 13.6323L13.1199 12.7715C14.1184 12.2256 14.6613 11.4384 14.7324 10.4831C14.8302 9.17095 13.8912 8.06874 12.2596 8.06874C10.5859 8.06874 9.48941 9.22344 9.39245 10.5251C9.37838 10.714 9.38223 10.945 9.4052 11.0605L10.8968 11.1024C10.8649 10.966 10.8661 10.8085 10.8747 10.6931C10.9286 9.96874 11.4285 9.47537 12.1549 9.47537C12.7864 9.47537 13.1949 9.92675 13.1511 10.5146C13.1105 11.0605 12.832 11.4069 12.1618 11.7848L10.877 12.4986C9.49363 13.2649 9.04233 14.3776 8.93562 15.6687Z" fill="currentColor"/><path d="M18.5354 22.4894C20.2617 22.4894 21.4093 21.3557 21.507 20.0435C21.611 18.6474 20.6834 17.8181 19.6015 17.7866L21.5745 16.17L21.6699 14.8894H16.691L16.5917 16.2225H19.6127L17.5574 17.9545L18.1505 19.0358C18.326 18.9413 18.6044 18.8783 18.8254 18.8783C19.457 18.8783 19.9778 19.2352 19.9207 20.0015C19.8754 20.6104 19.3942 21.1352 18.6257 21.1352C17.8784 21.1352 17.4025 20.5999 17.428 19.8336L15.9098 20.1485C15.922 21.3976 16.8617 22.4894 18.5354 22.4894Z" fill="currentColor"/></svg>
  ),
  Url: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}><path d="M12 21C16.9706 21 21 16.9706 21 12C21 7.02944 16.9706 3 12 3C7.02944 3 3 7.02944 3 12C3 16.9706 7.02944 21 12 21ZM12 23C5.92487 23 1 18.0751 1 12C1 5.92487 5.92487 1 12 1C18.0751 1 23 5.92487 23 12C23 18.0751 18.0751 23 12 23ZM14.3249 13.2745C14.1224 13.7495 13.7439 14.1278 13.2688 14.3302L8.15609 16.5076C7.74506 16.6827 7.32753 16.248 7.50176 15.848L9.71502 10.7663C9.91651 10.3037 10.2854 9.93439 10.7478 9.73233L15.8459 7.50439C16.2556 7.32533 16.6773 7.75692 16.506 8.15864L14.3249 13.2745Z" fill="currentColor"/></svg>
  ),
  Phone: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className}><path d="M5 2.5h6a1 1 0 011 1v9a1 1 0 01-1 1H5a1 1 0 01-1-1v-9a1 1 0 011-1z" {...s}/><path d="M7 11.5h2" {...s}/></svg>
  ),
  Email: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className}><rect x="2" y="3.5" width="12" height="9" rx="1.5" {...s}/><path d="M2 4.5l6 4 6-4" {...s}/></svg>
  ),
  Location: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className}><path d="M8 14s-4.5-3.5-4.5-7a4.5 4.5 0 019 0c0 3.5-4.5 7-4.5 7z" {...s}/><circle cx="8" cy="7" r="1.5" {...s}/></svg>
  ),
  Barcode: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className}><path d="M2 3v10M5 3v10M7 3v10M10 3v10M12 3v10M14 3v10" {...s} strokeWidth="1"/></svg>
  ),
  Progress: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className}><rect x="2" y="6" width="12" height="4" rx="2" {...s}/><rect x="2" y="6" width="7" height="4" rx="2" fill="currentColor" stroke="none" opacity="0.3"/></svg>
  ),
  Currency: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className}><path d="M8 2v12M5 5.5C5 4.1 6.3 3 8 3s3 1.1 3 2.5S9.7 8 8 8s-3 1.1-3 2.5S6.3 13 8 13s3-1.1 3-2.5" {...s}/></svg>
  ),
  Rating: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className}><path d="M8 1.5l2 4 4.5.7-3.2 3.1.8 4.4L8 11.5l-4 2.2.8-4.4L1.5 6.2 6 5.5z" {...s}/></svg>
  ),

  // ── System ──
  CreatedUser: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}><path d="M15.5 6.5C15.5 3.7385 13.26 1.5 10.5 1.5C7.74001 1.5 5.50001 3.7385 5.50001 6.5C5.50001 9.2615 7.74001 11.5 10.5 11.5C13.26 11.5 15.5 9.2615 15.5 6.5ZM10.5 9.5C8.84501 9.5 7.50001 8.157 7.50001 6.5C7.50001 4.843 8.84501 3.5 10.5 3.5C12.155 3.5 13.5 4.843 13.5 6.5C13.5 8.157 12.155 9.5 10.5 9.5Z" fill="currentColor"/><path d="M3 19C3 18.6545 3.045 18.3195 3.125 18C3.57 16.275 5.135 15 7 15H12.9792V13H7C3.685 13 1 15.6865 1 19V20C1 21.1 1.9 22 3 22H12.9543V20H3V19Z" fill="currentColor"/><path d="M18.5 22C17.9477 22 17.5 21.5523 17.5 21V19H15.5C14.9477 19 14.5 18.5523 14.5 18C14.5 17.4477 14.9477 17 15.5 17H17.5V15C17.5 14.4477 17.9477 14 18.5 14C19.0523 14 19.5 14.4477 19.5 15V17H21.5C22.0523 17 22.5 17.4477 22.5 18C22.5 18.5523 22.0523 19 21.5 19H19.5V21C19.5 21.5523 19.0523 22 18.5 22Z" fill="currentColor"/></svg>
  ),
  ModifiedUser: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}><path d="M16.5 6.5C16.5 3.7385 14.26 1.5 11.5 1.5C8.74 1.5 6.5 3.7385 6.5 6.5C6.5 9.2615 8.74 11.5 11.5 11.5C14.26 11.5 16.5 9.2615 16.5 6.5ZM11.5 9.5C9.845 9.5 8.5 8.157 8.5 6.5C8.5 4.843 9.845 3.5 11.5 3.5C13.155 3.5 14.5 4.843 14.5 6.5C14.5 8.157 13.155 9.5 11.5 9.5Z" fill="currentColor"/><path d="M4.00781 19C4.00781 18.6545 4.05281 18.3195 4.13281 18C4.57781 16.275 6.14281 15 8.00781 15H14.525V13H8.00781C4.69281 13 2.00781 15.6865 2.00781 19V20C2.00781 21.1 2.90781 22 4.00781 22H12.5V20H4.00781V19Z" fill="currentColor"/><path d="M22.1803 11.03C21.7003 10.76 21.0903 10.92 20.8103 11.4L20.224 12.418L21.9611 13.4209L22.5503 12.4C22.8203 11.92 22.6603 11.31 22.1803 11.03Z" fill="currentColor"/><path d="M21.4613 14.287L19.725 13.2846L15.4603 20.69C15.3703 20.85 15.3203 21.04 15.3403 21.23L15.4503 22.5C15.4603 22.54 15.4803 22.57 15.5103 22.59C15.5403 22.6 15.6103 22.59 15.6103 22.59L16.7703 22.06C16.9503 21.98 17.1003 21.84 17.2003 21.67L21.4613 14.287Z" fill="currentColor"/></svg>
  ),
  CreatedTime: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}><path d="M8 3C8 2.44772 7.55228 2 7 2C6.44772 2 6 2.44772 6 3H3.99997C2.8954 3 2 3.89543 2 5V20C2 21.1046 2.89543 22 4 22H13V20H4V11H22V5C22 3.89543 21.1046 3 20 3H18C18 2.44772 17.5523 2 17 2C16.4477 2 16 2.44772 16 3H8ZM20 9H4V5H6C6 5.55228 6.44772 6 7 6C7.55228 6 8 5.55228 8 5H16C16 5.55228 16.4477 6 17 6C17.5523 6 18 5.55228 18 5H20V9Z" fill="currentColor"/><path d="M18 15C18 14.4477 18.4477 14 19 14C19.5523 14 20 14.4477 20 15V17H22C22.5523 17 23 17.4477 23 18C23 18.5523 22.5523 19 22 19H20V21C20 21.5523 19.5523 22 19 22C18.4477 22 18 21.5523 18 21V19H16C15.4477 19 15 18.5523 15 18C15 17.4477 15.4477 17 16 17H18V15Z" fill="currentColor"/></svg>
  ),
  ModifiedTime: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}><path d="M8 3C8 2.44772 7.55228 2 7 2C6.44772 2 6 2.44772 6 3H3.99997C2.8954 3 2 3.89543 2 5V20C2 21.1046 2.89543 22 4 22H14V20H4V11H22V5C22 3.89543 21.1046 3 20 3H18C18 2.44772 17.5523 2 17 2C16.4477 2 16 2.44772 16 3H8ZM20 9H4V5H6C6 5.55228 6.44772 6 7 6C7.55228 6 8 5.55228 8 5H16C16 5.55228 16.4477 6 17 6C17.5523 6 18 5.55228 18 5H20V9Z" fill="currentColor"/><path d="M21.317 13.487C21.0778 13.3489 20.772 13.4309 20.634 13.67L16.884 20.1652L18.616 21.1652L22.366 14.67C22.5041 14.4309 22.4222 14.1251 22.183 13.987L21.317 13.487Z" fill="currentColor"/><path d="M16.25 23.2633L18.116 22.0312L16.384 21.0312L16.25 23.2633Z" fill="currentColor"/></svg>
  ),

  // ── Extended ──
  Formula: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className}><path d="M4 3h5.5a2.5 2.5 0 010 5H6M4 13h5.5a2.5 2.5 0 000-5H6" {...s}/><path d="M3 8h7" {...s}/></svg>
  ),
  SingleLink: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className}><rect x="1.5" y="4" width="5" height="8" rx="1" {...s}/><rect x="9.5" y="4" width="5" height="8" rx="1" {...s}/><path d="M6.5 8h3" {...s}/><path d="M8.5 6l2 2-2 2" {...s}/></svg>
  ),
  DuplexLink: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className}><rect x="1.5" y="4" width="5" height="8" rx="1" {...s}/><rect x="9.5" y="4" width="5" height="8" rx="1" {...s}/><path d="M6.5 7h3M6.5 9h3" {...s}/><path d="M8.5 5.5l1.5 1.5-1.5 1.5M7.5 10.5L6 9l1.5-1.5" {...s}/></svg>
  ),
  Lookup: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className}><rect x="2" y="3" width="8" height="7" rx="1" {...s}/><circle cx="12" cy="11" r="2.5" {...s}/><path d="M14 13l-1-1" {...s}/></svg>
  ),

  // ── AI ──
  ai_summary: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className}><rect x="2" y="2" width="12" height="12" rx="2" {...s}/><path d="M5 5h6M5 8h4M5 11h2" {...s}/></svg>
  ),
  ai_transition: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className}><path d="M2 5h5M9 5h5M2 8h12M2 11h5M9 11h5" {...s}/><path d="M7.5 3.5l1 3-1 3" {...s} strokeWidth="1"/></svg>
  ),
  ai_extract: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className}><rect x="2" y="2" width="12" height="12" rx="2" {...s}/><path d="M5 6h6M5 9h3" {...s}/><path d="M10 9l2 2M10 11l2-2" {...s}/></svg>
  ),
  ai_classify: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className}><circle cx="5" cy="5" r="2.5" {...s}/><circle cx="11" cy="5" r="2.5" {...s}/><circle cx="8" cy="11.5" r="2.5" {...s}/></svg>
  ),
  ai_tag: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className}><path d="M2 8.6V3a1 1 0 011-1h5.6a1 1 0 01.7.3l5.4 5.4a1 1 0 010 1.4l-5.6 5.6a1 1 0 01-1.4 0L2.3 9.3a1 1 0 01-.3-.7z" {...s}/><circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none"/></svg>
  ),
  ai_custom: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className}><path d="M8 1.5l1.5 3 3.5.5-2.5 2.4.6 3.4L8 9.5l-3.1 1.8.6-3.4L3 5.5l3.5-.5z" {...s}/><path d="M4 13h8" {...s}/></svg>
  ),
};

// Fallback icon
const FallbackIcon = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" className={className}><path d="M3 4h10M3 8h10M3 12h6" {...s}/></svg>
);

export function FieldIcon({ type, size = 16, className }: { type: FieldType | string; size?: number; className?: string }) {
  const Icon = ICONS[type] ?? FallbackIcon;
  return <Icon size={size} className={className} />;
}
