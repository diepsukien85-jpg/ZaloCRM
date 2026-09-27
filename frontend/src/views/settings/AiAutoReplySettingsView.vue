<!--
  AiAutoReplySettingsView.vue — AI tự trả lời khách 1-1, CẤU HÌNH RIÊNG TỪNG NICK.

  Mỗi nick Zalo là một thẻ: xưng hô, lời dặn, khung giờ, thẻ kích hoạt, trần tin,
  bộ khung trả lời riêng. Bấm thẻ để sửa; "+ Thêm nick" để cấu hình nick khác.
  Chỉ khách mang thẻ kích hoạt của nick đó mới được AI trả lời → tin khác không
  tốn lượt gọi AI. Phỏng theo phần AI của ZL-CRM (Thầy Nguyễn Tất Kiểm, Apache-2.0).
-->
<template>
  <div class="aar">
    <div class="aar-title">
      <h2>AI tự trả lời khách</h2>
      <p>
        Mỗi nick Zalo có <strong>cấu hình riêng</strong> (xưng hô, lời dặn, bảng giá, khung giờ…).
        AI chỉ trả lời <strong>chat 1-1</strong> của khách đang mang <strong>thẻ kích hoạt</strong> của nick đó;
        tin khác không tốn lượt gọi AI.
      </p>
    </div>

    <v-alert v-if="loadError" type="error" density="compact" class="mb-4">{{ loadError }}</v-alert>

    <!-- ════════ Thẻ cấu hình từng nick ════════ -->
    <div class="aar-section-title">Cấu hình theo nick</div>
    <div class="aar-cards mb-6">
      <button v-for="p in profiles" :key="p.zaloAccountId" type="button" class="aar-card" @click="openProfile(p.zaloAccountId)">
        <div class="aar-card-head">
          <div class="aar-avatar">{{ (p.accountName || '?').charAt(0).toUpperCase() }}</div>
          <div class="aar-card-name">
            <div class="aar-card-title">{{ p.accountName }}</div>
            <div class="aar-card-sub">{{ p.accountStatus === 'connected' ? 'Đang kết nối' : 'Mất kết nối' }}</div>
          </div>
          <v-chip size="small" :color="statusColor(p)" variant="flat">{{ statusLabel(p) }}</v-chip>
        </div>
        <div class="aar-card-row">
          <span class="aar-card-label">Thẻ:</span>
          <span v-if="!p.triggerTags.length" class="text-warning">chưa chọn thẻ</span>
          <v-chip v-for="t in p.triggerTags" :key="t" size="x-small" class="mr-1" variant="tonal">{{ cleanTag(t) }}</v-chip>
        </div>
        <div class="aar-card-row">
          <span class="aar-card-label">Hướng dẫn:</span>
          <span class="aar-ellipsis">{{ guideSummary(p) }}</span>
        </div>
        <div class="aar-card-row">
          <span class="aar-card-label">Giờ:</span> {{ p.hourStart }}h → {{ p.hourEnd }}h
        </div>
        <div class="aar-card-row">
          <span class="aar-card-label">Tự học:</span>
          <template v-if="p.learningEnabled">
            <span v-if="p.quality7d !== null" :class="scoreClass(p.quality7d)">chất lượng 7 ngày {{ p.quality7d }}%</span>
            <span v-else class="text-grey">chưa đủ dữ liệu</span>
            <span class="ml-1">· {{ p.lessonCount }} bài học</span>
          </template>
          <span v-else class="text-grey">đang tắt</span>
        </div>
        <div class="aar-card-foot">
          Hôm nay: gửi {{ p.today.sent || 0 }} · thử {{ p.today.dry_run || 0 }} · chuyển người {{ p.today.handoff || 0 }} · lỗi {{ p.today.error || 0 }}
        </div>
      </button>
      <button v-if="isAdmin" type="button" class="aar-card aar-card-add" :disabled="!unconfiguredAccounts.length" @click="openNew">
        <div class="aar-add-plus">＋</div>
        <div>{{ unconfiguredAccounts.length ? 'Thêm cấu hình cho nick khác' : 'Mọi nick đều đã có cấu hình' }}</div>
      </button>
    </div>

    <!-- ════════ Bộ khung dùng chung ════════ -->
    <v-card variant="outlined" class="mb-5">
      <v-card-title class="d-flex align-center text-body-1">
        Bộ khung trả lời dùng chung (mọi nick)
        <v-spacer />
        <v-btn v-if="isAdmin" size="small" color="primary" variant="tonal" @click="openEntry(null, null)">Thêm mục</v-btn>
      </v-card-title>
      <v-card-text>
        <p class="aar-hint">
          Mục ở đây áp dụng cho mọi nick. Mục riêng của từng nick (bảng giá riêng…) thêm trong thẻ cấu hình của nick đó.
          AI chỉ được nêu giá, ship, chính sách có trong bộ khung; không có thì hẹn khách kiểm tra lại.
        </p>
        <PlaybookTable :entries="sharedEntries" :editable="isAdmin" @edit="(e: PlaybookEntry) => openEntry(e, null)" @remove="removeEntry" />
      </v-card-text>
    </v-card>

    <!-- ════════ Chạy thử 1 hội thoại ════════ -->
    <v-card variant="outlined" class="mb-5">
      <v-card-title class="text-body-1">Chạy thử với một hội thoại</v-card-title>
      <v-card-text>
        <p class="aar-hint">
          Dán link hội thoại (vd <code>crm…/chat/&lt;id&gt;</code>). AI dùng cấu hình của nick nhận tin để viết thử câu trả lời,
          <strong>không gửi</strong>, bỏ qua công tắc/khung giờ. Hội thoại vẫn phải có thẻ kích hoạt.
        </p>
        <div class="aar-row">
          <v-text-field v-model="testInput" label="Link hoặc ID hội thoại" density="compact" hide-details class="flex-grow-1" />
          <v-btn :loading="testing" color="primary" variant="tonal" @click="runTest">Chạy thử</v-btn>
        </div>
        <v-alert v-if="testResult" class="mt-3" density="compact" :type="testResult.decision === 'dry_run' ? 'success' : 'info'" variant="tonal">
          <div><strong>{{ decisionLabel(testResult.decision) }}</strong> · {{ testResult.reason }}</div>
          <div v-if="testResult.content" class="aar-reply">{{ testResult.content }}</div>
        </v-alert>
      </v-card-text>
    </v-card>

    <!-- ════════ Nhật ký ════════ -->
    <v-card variant="outlined">
      <v-card-title class="d-flex align-center text-body-1">
        Nhật ký gần đây
        <v-spacer />
        <v-select
          v-model="logAccount"
          :items="logAccountItems"
          density="compact"
          hide-details
          style="max-width: 220px;"
          @update:model-value="loadLogs"
        />
        <v-btn size="small" variant="text" icon="mdi-refresh" @click="loadLogs" />
      </v-card-title>
      <v-card-text>
        <v-alert v-if="logs.length === 0" type="info" density="compact" variant="tonal">Chưa có lượt nào.</v-alert>
        <v-table v-else density="compact">
          <thead>
            <tr><th>Lúc</th><th>Khách · nick</th><th>Kết quả</th><th>Nội dung / lý do</th><th>Sau đó</th><th v-if="isAdmin">Chấm</th></tr>
          </thead>
          <tbody>
            <tr v-for="l in logs" :key="l.id">
              <td class="aar-nowrap">{{ fmtTime(l.createdAt) }}</td>
              <td>
                <router-link :to="`/chat/${l.conversationId}`">{{ l.customerName || 'Khách' }}</router-link>
                <div class="text-grey text-caption">{{ l.nickName }}</div>
              </td>
              <td><v-chip size="x-small" :color="decisionColor(l.decision)" variant="tonal">{{ decisionLabel(l.decision) }}</v-chip></td>
              <td>
                <div v-if="l.customerText" class="text-caption text-grey">Khách: {{ l.customerText }}</div>
                <div v-if="l.content" class="aar-reply">{{ l.content }}</div>
                <div class="text-grey text-caption">{{ l.reason }}</div>
                <div v-if="l.correctedReply" class="text-caption text-success">Câu đúng: {{ l.correctedReply }}</div>
              </td>
              <td>
                <v-chip v-if="l.outcome" size="x-small" variant="tonal" :color="outcomeColor(l.outcome)" :title="l.staffFollowup ? 'Nhân viên nhắn: ' + l.staffFollowup : (l.customerFollowup || '')">
                  {{ outcomeLabel(l.outcome) }}
                </v-chip>
                <span v-else-if="l.decision === 'sent' || l.decision === 'dry_run'" class="text-caption text-grey">đang theo dõi</span>
              </td>
              <td v-if="isAdmin" class="aar-nowrap">
                <template v-if="l.decision === 'sent' || l.decision === 'dry_run'">
                  <v-btn size="x-small" variant="text" icon="mdi-thumb-up-outline" :color="l.feedback === 'good' ? 'success' : undefined" title="Trả lời tốt" @click="rateGood(l)" />
                  <v-btn size="x-small" variant="text" icon="mdi-thumb-down-outline" :color="l.feedback === 'bad' ? 'error' : undefined" title="Chưa tốt — dạy lại AI" @click="openBad(l)" />
                </template>
              </td>
            </tr>
          </tbody>
        </v-table>
      </v-card-text>
    </v-card>

    <!-- ════════ Hộp thoại cấu hình 1 nick ════════ -->
    <v-dialog v-model="editorOpen" max-width="960" scrollable>
      <v-card>
        <v-card-title class="d-flex align-center">
          <span v-if="editingAccountId">Cấu hình AI · nick <strong class="ml-1">{{ accountName(editingAccountId) }}</strong></span>
          <span v-else>Thêm cấu hình cho nick</span>
          <v-spacer />
          <v-btn icon="mdi-close" variant="text" size="small" @click="editorOpen = false" />
        </v-card-title>
        <v-divider />
        <v-card-text class="aar-editor">
          <!-- Chọn nick (chỉ khi thêm mới) -->
          <template v-if="!editingConfigured">
            <div class="aar-step">Chọn nick Zalo</div>
            <v-select
              v-model="newAccountId"
              :items="unconfiguredAccounts.map((a) => ({ title: a.name, value: a.id }))"
              label="Nick Zalo chưa có cấu hình"
              @update:model-value="selectNewAccount"
            />
          </template>

          <template v-if="editingAccountId">
            <div class="aar-row mb-2">
              <v-switch
                v-model="form.enabled"
                color="success"
                base-color="grey-darken-1"
                inset
                hide-details
                :label="form.enabled ? 'Đang bật' : 'Đang tắt'"
              />
              <v-btn-toggle v-model="form.mode" mandatory density="compact" color="primary" variant="outlined">
                <v-btn value="auto">Tự gửi cho khách</v-btn>
                <v-btn value="dry_run">Chạy thử (không gửi)</v-btn>
              </v-btn-toggle>
            </div>
            <p v-if="form.mode === 'dry_run'" class="aar-hint">
              Chạy thử: AI viết câu trả lời vào nhật ký nhưng KHÔNG gửi cho khách.
            </p>

            <!-- Thẻ kích hoạt của đúng nick này -->
            <div class="aar-step mt-4">Thẻ kích hoạt</div>
            <div v-if="loadingTags" class="aar-hint">Đang tải thẻ…</div>
            <template v-else>
              <div class="aar-taggroup-title">Thẻ phân loại Zalo của nick <strong>{{ accountName(editingAccountId) }}</strong></div>
              <div v-if="zaloTags.length === 0" class="aar-hint">
                Nick này chưa có thẻ phân loại nào. Tạo thẻ trên app Zalo (vd "Bot AI"), rồi mở lại sau ít phút (danh sách thẻ trong CRM cập nhật 15 phút/lần).
              </div>
              <v-chip-group v-else v-model="form.triggerTags" multiple column filter>
                <v-chip v-for="l in zaloTags" :key="l.value" :value="l.value" :color="l.color" variant="outlined" size="small">
                  {{ l.emoji ? l.emoji + ' ' : '' }}{{ l.text }} <span class="aar-count">{{ l.count }} khách</span>
                </v-chip>
              </v-chip-group>
              <template v-if="crmTags.length">
                <div class="aar-taggroup-title mt-2">Tag CRM</div>
                <v-chip-group v-model="form.triggerTags" multiple column filter>
                  <v-chip v-for="t in crmTags" :key="t.value" :value="t.value" :color="t.color" variant="outlined" size="small">
                    {{ t.text }} <span class="aar-count">{{ t.count }} khách</span>
                  </v-chip>
                </v-chip-group>
              </template>
              <v-alert :type="form.triggerTags.length ? 'success' : 'warning'" variant="tonal" density="compact" class="mt-2">
                <template v-if="form.triggerTags.length">
                  AI sẽ trả lời khách của nick này đang mang thẻ: <strong>{{ form.triggerTags.map(cleanTag).join(', ') }}</strong>
                  (hiện khoảng <strong>{{ selectedCount }}</strong> khách).
                </template>
                <template v-else>Chưa chọn thẻ nào → AI không trả lời ai cả.</template>
              </v-alert>
            </template>

            <!-- Xưng hô theo giới tính Zalo -->
            <div class="aar-step mt-5">Xưng hô với khách</div>
            <div class="aar-row">
              <v-switch
                v-model="form.addressByGender"
                color="success"
                base-color="grey-darken-1"
                inset
                hide-details
                label="Gọi theo giới tính Zalo (nữ → chị, nam → anh)"
              />
              <v-text-field v-model="form.selfPronoun" label="AI tự xưng" density="compact" hide-details style="max-width: 160px;" />
            </div>
            <p class="aar-hint">
              Bật: AI đọc giới tính trên Zalo của khách, nữ thì gọi "chị", nam thì gọi "anh", tự xưng "{{ form.selfPronoun || 'em' }}";
              chưa rõ thì gọi "anh/chị". Quy tắc này đứng trên phần xưng hô trong hướng dẫn / skill.
            </p>

            <!-- Tư vấn từ kho sản phẩm thật -->
            <div class="aar-step mt-5">Tư vấn sản phẩm từ kho</div>
            <v-alert v-if="!server.catalog" type="warning" variant="tonal" density="compact" class="mb-2">
              Server chưa nối kho sản phẩm bot-noi-bo (BOT_NOIBO_RO_DB_URL) — AI chưa tra được giá/tồn kho.
            </v-alert>
            <div class="aar-row">
              <v-switch v-model="form.useProductCatalog" color="success" base-color="grey-darken-1" inset hide-details
                label="Tra kho thật (giá lẻ / CTV / NPP, tồn kho, mô tả) để tư vấn cụ thể" />
              <v-switch v-model="form.sendProductImages" color="success" base-color="grey-darken-1" inset hide-details
                :disabled="!form.useProductCatalog" label="Gửi kèm ảnh sản phẩm (tối đa 3)" />
            </div>
            <p class="aar-hint">
              Khi khách hỏi món hàng, AI tìm trong kho bot-noi-bo các món <strong>còn hàng</strong> khớp nhu cầu, gợi ý 2-3 mẫu với giá thật.
              Giá CTV / NPP chỉ nêu khi khách hỏi giá sỉ. Không bao giờ nêu giá vốn.
            </p>

            <!-- Chuyển người + thông báo -->
            <div class="aar-step mt-5 d-flex align-center flex-wrap" style="gap: 8px;">
              Chuyển người & thông báo Telegram
              <v-spacer />
              <v-btn v-if="isAdmin && server.telegram" size="small" variant="tonal" prepend-icon="mdi-send" :loading="testingTg" @click="testTelegram">Gửi thử</v-btn>
            </div>
            <v-alert v-if="!server.telegram" type="warning" variant="tonal" density="compact" class="mb-2">
              Server chưa cấu hình bot Telegram (HANDOFF_TELEGRAM_BOT_TOKEN) — chưa báo được khi chuyển người.
            </v-alert>
            <div class="aar-row">
              <v-switch v-model="form.notifyHandoff" color="success" base-color="grey-darken-1" inset hide-details
                label="Báo Telegram khi AI chuyển khách cho người thật" />
              <v-text-field v-model="form.handoffChatId" density="compact" hide-details style="max-width: 220px;"
                label="Telegram chat id" :placeholder="server.defaultChatId ? `mặc định ${server.defaultChatId}` : ''" />
              <v-text-field v-model.number="form.handoffPauseMinutes" type="number" min="0" density="compact" hide-details style="max-width: 200px;"
                label="Không báo lại cùng khách (phút)" />
            </div>
            <p class="aar-hint">
              Khi chuyển người, AI vẫn nói một câu với khách (vd "em ghi nhận rồi, anh Mẫn sẽ nhắn lại"), hội thoại giữ ở "Chưa rep",
              và gửi Telegram theo mẫu: mức KHẨN/THƯỜNG, khách, lý do, tin khách nhắn, link hội thoại. Để trống chat id = dùng chat mặc định của server.
            </p>

            <!-- Hướng dẫn cho AI (skill) — viết tay hoặc tải file -->
            <div class="aar-step mt-5 d-flex align-center flex-wrap" style="gap: 8px;">
              Hướng dẫn cho AI của nick này
              <v-spacer />
              <v-btn size="small" variant="text" prepend-icon="mdi-text-box-plus-outline" @click="insertGuideTemplate">Chèn mẫu</v-btn>
              <v-btn size="small" color="primary" variant="tonal" prepend-icon="mdi-upload" :loading="readingSkill" @click="guideFileInput?.click()">
                Tải lên file skill (.skill, .zip, .md)
              </v-btn>
              <input ref="guideFileInput" type="file" accept=".skill,.zip,.md,.markdown,.txt,application/zip,text/plain,text/markdown" hidden @change="onGuideFile" />
              <input ref="refFileInput" type="file" accept=".md,.markdown,.txt,text/plain,text/markdown" multiple hidden @change="onReferenceFiles" />
            </div>
            <p class="aar-hint">
              Viết hoặc tải lên một hướng dẫn (skill) cho AI: vai trò, cách xưng hô, giọng văn, cách tư vấn, thông tin sản phẩm…
              AI của nick này sẽ làm theo. Giá/chính sách ghi ở đây AI được phép nêu.
              Tải file <strong>.skill / .zip</strong>: SKILL.md vào ô dưới, các file trong references/ thành tài liệu tham khảo.
            </p>
            <div v-if="form.guideFileName" class="mb-2">
              <v-chip size="small" color="primary" variant="tonal" prepend-icon="mdi-file-document-outline" closable @click:close="form.guideFileName = null">
                Skill: {{ form.guideFileName }}
              </v-chip>
              <span class="aar-hint ml-2">Hướng dẫn chính đã nạp vào ô bên dưới, có thể sửa tiếp.</span>
            </div>
            <v-textarea
              v-model="form.extraInstruction"
              label="Hướng dẫn cho AI"
              rows="10"
              auto-grow
              max-rows="22"
              :counter="GUIDE_MAX"
              :rules="[(v: string) => !v || v.length <= GUIDE_MAX || 'Quá dài']"
              placeholder="Bấm &quot;Chèn mẫu&quot; để có khung gợi ý, hoặc tải lên file skill (.skill / .zip / .md)"
              class="aar-guide"
            />

            <!-- Tài liệu tham khảo của skill -->
            <div class="aar-taggroup-title mt-2 d-flex align-center flex-wrap" style="gap: 8px;">
              <span>Tài liệu tham khảo ({{ form.guideFiles.length }} file · {{ refChars.toLocaleString('vi-VN') }} ký tự)</span>
              <v-spacer />
              <v-btn size="x-small" variant="text" prepend-icon="mdi-file-plus-outline" @click="refFileInput?.click()">Thêm tài liệu (.md)</v-btn>
            </div>
            <p class="aar-hint">
              <strong>Luôn dùng</strong>: nạp vào mọi câu trả lời (câu cấm, giọng nói…).
              <strong>Tự chọn</strong>: chỉ nạp khi khách hỏi đúng chủ đề (giá, bảo hành, giao hàng…), mỗi lượt tối đa 3 file để AI trả lời nhanh và rẻ.
              <strong>Không dùng</strong>: giữ lại nhưng AI không đọc.
            </p>
            <div v-if="form.guideFiles.length === 0" class="aar-hint">Chưa có tài liệu tham khảo. Tải file .skill / .zip để nạp cả thư mục references/.</div>
            <div v-for="(f, i) in form.guideFiles" :key="f.path" class="aar-ref">
              <v-icon size="16" class="mr-1">mdi-file-document-outline</v-icon>
              <span class="aar-ref-name" :title="f.path">{{ f.path }}</span>
              <span class="aar-ref-size">{{ f.content.length.toLocaleString('vi-VN') }} ký tự</span>
              <v-btn-toggle v-model="f.mode" mandatory density="compact" variant="outlined" divided color="primary" class="aar-ref-mode">
                <v-btn value="always" size="x-small">Luôn dùng</v-btn>
                <v-btn value="auto" size="x-small">Tự chọn</v-btn>
                <v-btn value="off" size="x-small">Không dùng</v-btn>
              </v-btn-toggle>
              <v-btn size="x-small" variant="text" icon="mdi-eye-outline" title="Xem" @click="viewRef = f" />
              <v-btn size="x-small" variant="text" icon="mdi-delete-outline" color="error" title="Bỏ tài liệu" @click="form.guideFiles.splice(i, 1)" />
            </div>

            <!-- Bộ khung riêng của nick -->
            <div class="aar-step mt-5 d-flex align-center">
              Bộ khung trả lời riêng của nick này
              <v-spacer />
              <v-btn v-if="isAdmin" size="small" color="primary" variant="tonal" @click="openEntry(null, editingAccountId)">Thêm mục</v-btn>
            </div>
            <p class="aar-hint">AI dùng mục riêng của nick này + mục dùng chung. Mục riêng được ưu tiên khi cùng độ ưu tiên.</p>
            <PlaybookTable :entries="nickEntries" :editable="isAdmin" @edit="(e: PlaybookEntry) => openEntry(e, editingAccountId)" @remove="removeEntry" />

            <!-- Vòng tự học -->
            <div class="aar-step mt-5 d-flex align-center flex-wrap" style="gap: 8px;">
              Tự học (rút kinh nghiệm hằng ngày)
              <v-spacer />
              <v-btn
                v-if="isAdmin && editingConfigured"
                size="small" variant="flat" color="deep-purple" prepend-icon="mdi-human-male-board"
                @click="openTeach"
              >Dạy cho AI</v-btn>
              <v-btn
                v-if="isAdmin && editingConfigured"
                size="small" variant="tonal" color="primary" prepend-icon="mdi-school-outline"
                :loading="learning" :disabled="!form.learningEnabled" @click="learnNow"
              >Học ngay</v-btn>
            </div>
            <v-switch
              v-model="form.learningEnabled"
              color="success"
              base-color="grey-darken-1"
              inset
              hide-details
              :label="form.learningEnabled ? 'Đang bật tự học' : 'Tắt tự học'"
            />
            <p class="aar-hint">
              Sau mỗi câu trả lời, hệ thống theo dõi 30 phút: khách trả lời tiếp (tốt), nhân viên phải vào sửa hoặc khách phàn nàn (chưa tốt).
              Mỗi đêm 23h AI đọc lại các lượt trong ngày và cách nhân viên xử lý, rút thành <strong>bài học</strong> dùng cho các lần sau.
              Bạn chấm 👎 kèm câu đúng ở Nhật ký thì AI học ngay. AI chỉ học từ nhân viên và từ bạn, không học theo lời khách.
              <template v-if="editingProfile?.lastLearnedAt"> Lần học gần nhất: {{ fmtTime(editingProfile.lastLearnedAt) }}.</template>
            </p>

            <v-alert v-if="learnResult" :type="learnResult.ok ? 'success' : 'info'" variant="tonal" density="compact" closable class="mb-2" @click:close="learnResult = null">
              {{ learnResult.text }}
            </v-alert>
            <template v-if="editingConfigured">
              <div class="aar-taggroup-title">Chất lượng 14 ngày (tốt / (tốt + chưa tốt))</div>
              <div class="aar-quality">
                <div v-for="d in quality" :key="d.date" class="aar-qday" :title="qualityTitle(d)">
                  <div class="aar-qbar-wrap">
                    <div v-if="d.score !== null" class="aar-qbar" :class="scoreClass(d.score)" :style="{ height: Math.max(d.score, 4) + '%' }" />
                  </div>
                  <div class="aar-qlabel">{{ d.date.slice(8, 10) }}</div>
                </div>
              </div>

              <div class="aar-taggroup-title mt-3 d-flex align-center">
                Bài học của nick này ({{ lessons.filter((l) => l.active).length }} đang dùng)
              </div>
              <div v-if="lessons.length === 0" class="aar-hint">Chưa có bài học nào. Bài học sẽ xuất hiện sau khi AI trả lời khách và được chấm.</div>
              <div v-for="l in lessons" :key="l.id" class="aar-lesson" :class="{ 'aar-lesson-off': !l.active }">
                <v-chip size="x-small" variant="tonal" :color="l.source === 'manual' ? 'primary' : l.source === 'teach' ? 'deep-purple' : l.source === 'feedback' ? 'warning' : 'info'" class="mr-2">
                  {{ ({ manual: 'tự viết', feedback: 'từ phản hồi', teach: 'đã dạy', daily: 'tự học' } as Record<string, string>)[l.source] || l.source }}
                </v-chip>
                <span class="aar-lesson-text">{{ l.content }}</span>
                <template v-if="isAdmin">
                  <v-btn size="x-small" variant="text" :icon="l.active ? 'mdi-toggle-switch' : 'mdi-toggle-switch-off-outline'" :color="l.active ? 'success' : 'grey'" :title="l.active ? 'Tắt bài học' : 'Bật bài học'" @click="toggleLesson(l)" />
                  <v-btn size="x-small" variant="text" icon="mdi-pencil" title="Sửa" @click="editLesson(l)" />
                  <v-btn size="x-small" variant="text" icon="mdi-delete-outline" color="error" title="Xoá" @click="deleteLesson(l)" />
                </template>
              </div>
              <div v-if="isAdmin" class="aar-row mt-2">
                <v-text-field v-model="newLesson" density="compact" hide-details label="Thêm bài học tự viết (vd: Luôn hỏi số lượng trước khi báo giá sỉ)" class="flex-grow-1" @keyup.enter="addLesson" />
                <v-btn size="small" variant="tonal" @click="addLesson">Thêm</v-btn>
              </div>
            </template>

            <!-- Hàng rào -->
            <div class="aar-step mt-5">Khung giờ & giới hạn</div>
            <div class="aar-grid">
              <div class="aar-hours">
                <v-text-field v-model.number="form.hourStart" type="number" label="Từ giờ" min="0" max="23" density="comfortable" />
                <span>→</span>
                <v-text-field v-model.number="form.hourEnd" type="number" label="Đến giờ" min="1" max="24" density="comfortable" />
              </div>
              <v-text-field v-model.number="form.debounceSeconds" type="number" min="3" max="300" label="Gom tin khách nhắn dồn (giây)" hint="Khách ngừng nhắn chừng này giây thì AI trả lời 1 lần" persistent-hint />
              <v-text-field v-model.number="form.skipIfStaffRepliedWithinMin" type="number" min="0" label="Nhường nhân viên (phút)" hint="Nhân viên vừa nhắn khách trong khoảng này thì AI im" persistent-hint />
              <v-text-field v-model.number="form.maxRepliesPerDay" type="number" min="1" label="Tối đa tin AI mỗi ngày (nick này)" />
              <v-text-field v-model.number="form.maxRepliesPerConvPerDay" type="number" min="1" label="Tối đa tin AI mỗi khách mỗi ngày" />
            </div>
            <v-combobox
              v-model="form.blockedKeywords"
              label="Từ khoá chuyển người thật"
              multiple chips closable-chips
              class="mt-3"
              hint="Khách nhắn trúng những từ này thì AI không trả lời. Gõ rồi Enter để thêm."
              persistent-hint
            />
            <v-switch
              v-model="form.verifyGrounding"
              color="primary"
              inset
              hide-details
              class="mt-3"
              label="Kiểm duyệt căn cứ trước khi gửi (thêm 1 lượt AI soát giá/chính sách bịa)"
            />
          </template>
        </v-card-text>
        <v-divider />
        <v-card-actions>
          <v-btn v-if="editingConfigured && isAdmin" color="error" variant="text" @click="removeProfile">Xoá cấu hình nick này</v-btn>
          <v-spacer />
          <v-btn variant="text" @click="editorOpen = false">Huỷ</v-btn>
          <v-btn v-if="isAdmin" color="primary" variant="flat" :disabled="!editingAccountId" :loading="saving" @click="saveProfile">Lưu cấu hình</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- ════════ Dạy cho AI (trò chuyện) ════════ -->
    <v-dialog v-model="teachOpen" max-width="1100" persistent scrollable>
      <v-card class="teach-card">
        <v-card-title class="d-flex align-center">
          <v-icon class="mr-2" color="deep-purple">mdi-human-male-board</v-icon>
          Dạy cho AI · nick <strong class="ml-1">{{ accountName(editingAccountId) }}</strong>
          <v-spacer />
          <v-btn icon="mdi-close" variant="text" size="small" @click="closeTeach(false)" />
        </v-card-title>
        <v-divider />
        <v-card-text class="teach-body">
          <div class="teach-chat">
            <div ref="teachScroll" class="teach-messages">
              <div v-if="teachMsgs.length === 0" class="aar-hint teach-empty">
                Dạy AI bằng lời thường, ví dụ: <em>"Khách hỏi link nhóm Zalo thì phải nói rõ link đó là nhóm nào, của nick nào"</em>,
                hoặc <em>"Khách hỏi giá sỉ mà chưa nói số lượng thì hỏi số lượng trước"</em>.<br />
                Muốn xem bot đã hiểu chưa: gõ một câu như khách rồi bấm <strong>Thử hỏi như khách</strong>, bot sẽ trả lời bằng các bài học đang dạy.
                Chê chỗ nào thì dạy tiếp chỗ đó. Xong bấm <strong>Kết thúc & lưu</strong>.
              </div>
              <div v-for="(m, i) in teachMsgs" :key="i" class="teach-msg" :class="'teach-' + m.role">
                <div class="teach-who">{{ ({ owner: 'Anh dạy', teacher: 'AI trợ giảng', customer: 'Khách (thử)', bot: 'Bot trả lời thử' } as Record<string, string>)[m.role] }}</div>
                <div class="teach-text">{{ m.content }}</div>
              </div>
              <div v-if="teachBusy" class="teach-msg teach-teacher"><div class="teach-text">…</div></div>
            </div>
            <div class="teach-input">
              <v-textarea
                v-model="teachText" rows="2" auto-grow max-rows="6" hide-details density="compact"
                placeholder="Gõ lời dạy, hoặc gõ câu khách hỏi để thử…" @keydown.enter.exact.prevent="sendTeach"
              />
              <div class="aar-row mt-2">
                <v-btn color="deep-purple" variant="flat" size="small" prepend-icon="mdi-send" :loading="teachBusy === 'teach'" :disabled="!!teachBusy || !teachText.trim()" @click="sendTeach">Gửi lời dạy</v-btn>
                <v-btn variant="tonal" size="small" prepend-icon="mdi-account-question-outline" :loading="teachBusy === 'try'" :disabled="!!teachBusy || !teachText.trim()" @click="tryAsCustomer">Thử hỏi như khách</v-btn>
                <v-btn-toggle v-model="tryGender" density="compact" variant="outlined" divided mandatory color="primary">
                  <v-btn value="female" size="x-small">Khách nữ</v-btn>
                  <v-btn value="male" size="x-small">Khách nam</v-btn>
                  <v-btn value="" size="x-small">Chưa rõ</v-btn>
                </v-btn-toggle>
                <v-spacer />
                <v-btn size="x-small" variant="text" @click="resetTryConversation">Làm mới hội thoại thử</v-btn>
              </div>
            </div>
          </div>
          <div class="teach-side">
            <div class="aar-step">Bài học sẽ lưu ({{ teachOps.length }})</div>
            <p class="aar-hint">AI tự cập nhật danh sách này sau mỗi lời dạy: ưu tiên sửa bài cũ cùng chủ đề thay vì thêm mới, để bộ bài học luôn gọn.</p>
            <div v-if="teachOps.length === 0" class="aar-hint">Chưa có thay đổi.</div>
            <div v-for="(o, i) in teachOps" :key="i" class="teach-op" :class="'teach-op-' + o.op">
              <v-chip size="x-small" variant="flat" :color="o.op === 'add' ? 'success' : o.op === 'update' ? 'primary' : 'error'">
                {{ o.op === 'add' ? 'Thêm' : o.op === 'update' ? 'Sửa' : 'Bỏ' }}
              </v-chip>
              <div class="teach-op-text">
                <div v-if="o.before" class="teach-op-before">{{ o.before }}</div>
                <div v-if="o.content">{{ o.content }}</div>
              </div>
              <v-btn size="x-small" variant="text" icon="mdi-close" title="Bỏ thay đổi này" @click="teachOps.splice(i, 1)" />
            </div>
          </div>
        </v-card-text>
        <v-divider />
        <v-card-actions>
          <span class="aar-hint ml-2">Chưa lưu gì cho tới khi bấm Kết thúc & lưu.</span>
          <v-spacer />
          <v-btn variant="text" @click="closeTeach(false)">Đóng không lưu</v-btn>
          <v-btn color="deep-purple" variant="flat" prepend-icon="mdi-content-save-check" :loading="teachSaving" :disabled="!!teachBusy" @click="closeTeach(true)">
            Kết thúc & lưu bài học
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- ════════ Xem tài liệu tham khảo ════════ -->
    <v-dialog :model-value="!!viewRef" max-width="820" scrollable @update:model-value="(v: boolean) => { if (!v) viewRef = null; }">
      <v-card v-if="viewRef">
        <v-card-title class="d-flex align-center">
          {{ viewRef.path }}
          <v-spacer />
          <v-btn icon="mdi-close" variant="text" size="small" @click="viewRef = null" />
        </v-card-title>
        <v-divider />
        <v-card-text>
          <v-textarea v-model="viewRef.content" rows="18" auto-grow hide-details class="aar-guide" />
        </v-card-text>
      </v-card>
    </v-dialog>

    <!-- ════════ Hộp thoại chấm 👎 — dạy lại AI ════════ -->
    <v-dialog v-model="badDialog" max-width="640">
      <v-card>
        <v-card-title>Dạy lại AI</v-card-title>
        <v-card-text v-if="badLog">
          <div v-if="badLog.customerText" class="aar-hint">Khách: {{ badLog.customerText }}</div>
          <div class="aar-reply mb-3"><strong>AI đã trả lời:</strong> {{ badLog.content }}</div>
          <v-textarea v-model="badForm.correctedReply" label="Câu trả lời đúng lẽ ra là" rows="3" counter="2000" />
          <v-textarea v-model="badForm.note" label="Ghi chú cho AI (tuỳ chọn) — vd: không báo giá khi khách chưa nói số lượng" rows="2" counter="1000" />
          <p class="aar-hint">AI sẽ rút ngay một bài học từ phản hồi này và áp dụng cho nick {{ badLog.nickName }}.</p>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="badDialog = false">Huỷ</v-btn>
          <v-btn color="primary" :loading="sendingFeedback" @click="submitBad">Gửi & cho AI học</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- ════════ Hộp thoại mục kịch bản ════════ -->
    <v-dialog v-model="entryDialog" max-width="640">
      <v-card>
        <v-card-title>
          {{ editingEntry?.id ? 'Sửa mục' : 'Thêm mục' }}
          <span class="text-body-2 text-grey ml-2">
            {{ entryForm.zaloAccountId ? `riêng nick ${accountName(entryForm.zaloAccountId)}` : 'dùng chung mọi nick' }}
          </span>
        </v-card-title>
        <v-card-text>
          <v-alert v-if="entryError" type="error" density="compact" class="mb-3">{{ entryError }}</v-alert>
          <v-text-field v-model="entryForm.title" label="Tiêu đề" counter="200" class="mb-2" />
          <v-text-field v-model="entryForm.category" label="Nhóm (tuỳ chọn)" placeholder="bảng giá / ship / đổi trả / FAQ" class="mb-2" />
          <v-combobox
            v-model="entryForm.keywords"
            label="Từ khoá kích hoạt"
            multiple chips closable-chips
            hint="Khách nhắn trúng một từ thì mục được ưu tiên. Để trống = luôn cân nhắc."
            persistent-hint
            class="mb-2"
          />
          <v-textarea v-model="entryForm.content" label="Nội dung" rows="8" counter="8000" class="mt-3" />
          <div class="d-flex align-center" style="gap: 24px;">
            <v-text-field v-model.number="entryForm.priority" type="number" label="Ưu tiên (0-100)" min="0" max="100" density="compact" style="max-width: 180px;" />
            <v-switch v-model="entryForm.enabled" color="primary" inset label="Đang bật" hide-details />
          </div>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="entryDialog = false">Huỷ</v-btn>
          <v-btn color="primary" :loading="savingEntry" @click="saveEntry">Lưu</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, defineComponent, h, type PropType } from 'vue';
import { VBtn, VChip, VTable, VAlert } from 'vuetify/components';
import { api } from '@/api/index';
import { useToast } from '@/composables/use-toast';
import { useAuthStore } from '@/stores/auth';
import { readSkillFile, defaultReferenceMode } from '@/utils/read-skill-file';

interface PlaybookEntry {
  id: string; zaloAccountId: string | null; title: string; category: string | null; keywords: string[];
  content: string; priority: number; enabled: boolean;
}
interface Profile {
  zaloAccountId: string; enabled: boolean; mode: 'auto' | 'dry_run'; triggerTags: string[];
  hourStart: number; hourEnd: number; debounceSeconds: number; maxRepliesPerDay: number;
  maxRepliesPerConvPerDay: number; skipIfStaffRepliedWithinMin: number; blockedKeywords: string[];
  persona: string | null; extraInstruction: string | null; guideFileName: string | null; verifyGrounding: boolean;
  guideFiles: GuideFile[];
  learningEnabled: boolean; lastLearnedAt: string | null;
  addressByGender: boolean; selfPronoun: string;
  useProductCatalog: boolean; sendProductImages: boolean;
  notifyHandoff: boolean; handoffChatId: string | null; handoffPauseMinutes: number;
}
interface ProfileCard extends Profile {
  accountName: string; accountStatus: string; today: Record<string, number>;
  lessonCount: number; quality7d: number | null;
}
interface Lesson { id: string; content: string; source: string; active: boolean }
interface DayQuality { date: string; sent: number; good: number; bad: number; noReply: number; handoff: number; score: number | null }
interface AccountRow { id: string; name: string; status: string; configured: boolean }
interface LogRow {
  id: string; conversationId: string; decision: string; reason: string | null; content: string | null;
  createdAt: string; customerName: string | null; nickName: string | null;
  customerText: string | null; outcome: string | null; staffFollowup: string | null; customerFollowup: string | null;
  feedback: string | null; correctedReply: string | null; feedbackNote: string | null;
}
type GuideFile = { path: string; content: string; mode: 'always' | 'auto' | 'off' };
type TagOption = { value: string; text: string; color: string; emoji?: string | null; count: number };

/** Bảng mục kịch bản (dùng cho cả khung chung lẫn khung riêng từng nick). */
const PlaybookTable = defineComponent({
  props: {
    entries: { type: Array as PropType<PlaybookEntry[]>, required: true },
    editable: { type: Boolean, default: false },
  },
  emits: ['edit', 'remove'],
  setup(props, { emit }) {
    return () => props.entries.length === 0
      ? h(VAlert, { type: 'info', density: 'compact', variant: 'tonal' }, () => 'Chưa có mục nào. Nên thêm: bảng giá, phí ship, chính sách đổi trả, câu hỏi thường gặp.')
      : h(VTable, { density: 'compact' }, () => [
        h('thead', h('tr', ['Tiêu đề', 'Nhóm', 'Từ khoá', 'Ưu tiên', 'Bật', ''].map((t) => h('th', t)))),
        h('tbody', props.entries.map((e) => h('tr', { key: e.id }, [
          h('td', { class: 'aar-cell-title' }, e.title),
          h('td', e.category || '—'),
          h('td', e.keywords?.length
            ? e.keywords.map((k) => h(VChip, { size: 'x-small', class: 'mr-1' }, () => k))
            : h('span', { class: 'text-grey' }, 'luôn cân nhắc')),
          h('td', String(e.priority)),
          h('td', e.enabled ? '✓' : '—'),
          h('td', { class: 'text-right' }, props.editable ? [
            h(VBtn, { size: 'x-small', variant: 'text', icon: 'mdi-pencil', onClick: () => emit('edit', e) }),
            h(VBtn, { size: 'x-small', variant: 'text', icon: 'mdi-delete-outline', color: 'error', onClick: () => emit('remove', e) }),
          ] : []),
        ]))),
      ]);
  },
});

const toast = useToast();
const auth = useAuthStore();
const isAdmin = computed(() => ['owner', 'admin'].includes(auth.user?.role || ''));

const profiles = ref<ProfileCard[]>([]);
const accounts = ref<AccountRow[]>([]);
const playbook = ref<PlaybookEntry[]>([]);
const logs = ref<LogRow[]>([]);
const logAccount = ref('');
const loadError = ref('');

const unconfiguredAccounts = computed(() => accounts.value.filter((a) => !a.configured));
const sharedEntries = computed(() => playbook.value.filter((e) => !e.zaloAccountId));
const logAccountItems = computed(() => [
  { title: 'Mọi nick', value: '' },
  ...profiles.value.map((p) => ({ title: p.accountName, value: p.zaloAccountId })),
]);

// ── Editor 1 nick ──
const editorOpen = ref(false);
const editingAccountId = ref<string | null>(null);
const editingConfigured = ref(false);
const newAccountId = ref<string | null>(null);
const saving = ref(false);
const loadingTags = ref(false);
const zaloTags = ref<TagOption[]>([]);
const crmTags = ref<TagOption[]>([]);
const form = reactive<Omit<Profile, 'zaloAccountId'>>({
  enabled: false, mode: 'dry_run', triggerTags: [], hourStart: 7, hourEnd: 22, debounceSeconds: 20,
  maxRepliesPerDay: 300, maxRepliesPerConvPerDay: 15, skipIfStaffRepliedWithinMin: 10, blockedKeywords: [],
  persona: null, extraInstruction: '', guideFileName: null, guideFiles: [], verifyGrounding: true,
  learningEnabled: true, lastLearnedAt: null,
  addressByGender: true, selfPronoun: 'em',
  useProductCatalog: true, sendProductImages: true, notifyHandoff: true, handoffChatId: null, handoffPauseMinutes: 60,
});
const server = ref<{ catalog: boolean; telegram: boolean; defaultChatId: string | null }>({ catalog: false, telegram: false, defaultChatId: null });
const testingTg = ref(false);
async function testTelegram() {
  if (!editingAccountId.value) return;
  testingTg.value = true;
  try {
    await api.post(`/ai/auto-reply/profiles/${editingAccountId.value}/test-telegram`, { chatId: form.handoffChatId || undefined });
    toast.success('Đã gửi tin thử. Kiểm tra Telegram nhé.');
  } catch (err) {
    toast.error(errorText(err, 'Gửi thử lỗi'));
  } finally {
    testingTg.value = false;
  }
}

// ── Vòng tự học ──
const lessons = ref<Lesson[]>([]);
const quality = ref<DayQuality[]>([]);
const newLesson = ref('');
const learning = ref(false);
const editingProfile = computed(() => profiles.value.find((p) => p.zaloAccountId === editingAccountId.value) ?? null);
const learnResult = ref<{ ok: boolean; text: string } | null>(null);

// ── Dạy cho AI ──
type TeachMsg = { role: 'owner' | 'teacher' | 'customer' | 'bot'; content: string };
type TeachOp = { op: 'add' | 'update' | 'remove'; id?: string; content?: string; before?: string | null };
const teachOpen = ref(false);
const teachMsgs = ref<TeachMsg[]>([]);
const teachOps = ref<TeachOp[]>([]);
const teachText = ref('');
const teachBusy = ref<'' | 'teach' | 'try'>('');
const teachSaving = ref(false);
const tryGender = ref<'female' | 'male' | ''>('female');
const teachScroll = ref<HTMLElement | null>(null);

function scrollTeach() {
  setTimeout(() => { if (teachScroll.value) teachScroll.value.scrollTop = teachScroll.value.scrollHeight; }, 30);
}
function openTeach() {
  teachMsgs.value = [];
  teachOps.value = [];
  teachText.value = '';
  teachOpen.value = true;
}
function teachPayload(extra: Record<string, unknown> = {}) {
  return {
    transcript: teachMsgs.value.map((m) => ({ role: m.role, content: m.content })),
    pending: teachOps.value.map(({ op, id, content }) => ({ op, id, content })),
    ...extra,
  };
}
async function sendTeach() {
  const text = teachText.value.trim();
  if (!text || teachBusy.value || !editingAccountId.value) return;
  teachMsgs.value.push({ role: 'owner', content: text });
  teachText.value = '';
  teachBusy.value = 'teach';
  scrollTeach();
  try {
    const { data } = await api.post(`/ai/auto-reply/profiles/${editingAccountId.value}/teach`, teachPayload());
    teachMsgs.value.push({ role: 'teacher', content: data.reply });
    teachOps.value = data.preview;
  } catch (err) {
    teachMsgs.value.push({ role: 'teacher', content: `⚠️ ${errorText(err, 'Lỗi, anh gửi lại giúp em nhé.')}` });
  } finally {
    teachBusy.value = '';
    scrollTeach();
  }
}
async function tryAsCustomer() {
  const text = teachText.value.trim();
  if (!text || teachBusy.value || !editingAccountId.value) return;
  const payload = teachPayload({ text, gender: tryGender.value || null });
  teachMsgs.value.push({ role: 'customer', content: text });
  teachText.value = '';
  teachBusy.value = 'try';
  scrollTeach();
  try {
    const { data } = await api.post(`/ai/auto-reply/profiles/${editingAccountId.value}/teach/try`, payload);
    const extra = [
      data.action === 'handoff' ? '[Chuyển cho người thật]' : '',
      data.images?.length ? `[Gửi ảnh: ${data.images.join(', ')}]` : '',
    ].filter(Boolean).join(' ');
    teachMsgs.value.push({ role: 'bot', content: `${data.reply || '(không nói gì)'}${extra ? `\n${extra}` : ''}` });
  } catch (err) {
    teachMsgs.value.push({ role: 'bot', content: `⚠️ ${errorText(err, 'Thử không thành công')}` });
  } finally {
    teachBusy.value = '';
    scrollTeach();
  }
}
function resetTryConversation() {
  // Bỏ các lượt khách/bot thử (giữ lời dạy) để thử lại như cuộc trò chuyện mới.
  teachMsgs.value = teachMsgs.value.filter((m) => m.role === 'owner' || m.role === 'teacher');
}
async function closeTeach(save: boolean) {
  if (!save) {
    if (teachOps.value.length && !window.confirm('Đóng mà không lưu các bài học vừa dạy?')) return;
    teachOpen.value = false;
    return;
  }
  if (!editingAccountId.value) return;
  if (teachOps.value.length === 0 && !teachMsgs.value.some((m) => m.role === 'owner')) {
    teachOpen.value = false;
    return;
  }
  teachSaving.value = true;
  try {
    const { data } = await api.post(`/ai/auto-reply/profiles/${editingAccountId.value}/teach/finish`, teachPayload());
    lessons.value = data.lessons;
    learnResult.value = { ok: true, text: `Buổi dạy đã lưu: thêm ${data.added}, sửa ${data.updated}, bỏ ${data.removed} bài học. Bot áp dụng ngay từ tin tiếp theo.` };
    teachOpen.value = false;
    await loadProfiles();
  } catch (err) {
    toast.error(errorText(err, 'Lưu bài học không thành công'));
  } finally {
    teachSaving.value = false;
  }
}

const badDialog = ref(false);
const badLog = ref<LogRow | null>(null);
const badForm = reactive({ correctedReply: '', note: '' });
const sendingFeedback = ref(false);

function scoreClass(score: number) {
  return score >= 80 ? 'aar-good' : score >= 50 ? 'aar-mid' : 'aar-bad';
}
function qualityTitle(d: DayQuality) {
  return `${d.date}: gửi ${d.sent} · tốt ${d.good} · chưa tốt ${d.bad} · khách im ${d.noReply} · chuyển người ${d.handoff}`
    + (d.score !== null ? ` · điểm ${d.score}%` : '');
}
function outcomeLabel(o: string) {
  return ({
    customer_replied: 'Khách trả lời tiếp', no_reply: 'Khách chưa phản hồi', staff_intervened: 'Nhân viên vào sửa',
    customer_unhappy: 'Khách phàn nàn', staff_answered: 'Nhân viên đã trả lời', no_staff: 'Chưa ai trả lời',
  } as Record<string, string>)[o] || o;
}
function outcomeColor(o: string) {
  return ({ customer_replied: 'success', staff_intervened: 'warning', customer_unhappy: 'error', staff_answered: 'info' } as Record<string, string>)[o] || 'grey';
}

async function loadLearning(accountId: string) {
  const [l, q] = await Promise.all([
    api.get(`/ai/auto-reply/profiles/${accountId}/lessons`),
    api.get(`/ai/auto-reply/profiles/${accountId}/quality`, { params: { days: 14 } }),
  ]);
  lessons.value = l.data.lessons;
  quality.value = q.data.days;
}
async function learnNow() {
  if (!editingAccountId.value) return;
  learning.value = true;
  try {
    const { data } = await api.post(`/ai/auto-reply/profiles/${editingAccountId.value}/learn-now`);
    learnResult.value = data.skipped
      ? {
          ok: false,
          text: data.skipped === 'không có lượt nào để học'
            ? `Đã xem ${data.reviewed} lượt gần đây: chưa có lượt nào bị nhân viên sửa, khách phàn nàn hay bị chấm 👎 nên chưa có gì mới để học. Muốn AI học ngay, bấm "Dạy cho AI" hoặc chấm 👎 ở Nhật ký.`
            : `Chưa học được: ${data.skipped}.`,
        }
      : { ok: true, text: `Đã học ${data.reviewed} lượt: thêm ${data.added} bài học, bỏ ${data.removed} bài cũ.` };
    await Promise.all([loadLearning(editingAccountId.value), loadProfiles(), loadLogs()]);
  } catch (err) {
    toast.error(errorText(err, 'Học không thành công'));
  } finally {
    learning.value = false;
  }
}
async function addLesson() {
  if (!editingAccountId.value || !newLesson.value.trim()) return;
  try {
    await api.post(`/ai/auto-reply/profiles/${editingAccountId.value}/lessons`, { content: newLesson.value });
    newLesson.value = '';
    await loadLearning(editingAccountId.value);
  } catch (err) {
    toast.error(errorText(err, 'Không thêm được bài học'));
  }
}
async function toggleLesson(l: Lesson) {
  try {
    await api.put(`/ai/auto-reply/lessons/${l.id}`, { active: !l.active });
    l.active = !l.active;
  } catch (err) {
    toast.error(errorText(err, 'Không đổi được'));
  }
}
async function editLesson(l: Lesson) {
  const next = window.prompt('Sửa bài học', l.content);
  if (next === null || next.trim() === l.content) return;
  try {
    const { data } = await api.put(`/ai/auto-reply/lessons/${l.id}`, { content: next });
    Object.assign(l, data.lesson);
  } catch (err) {
    toast.error(errorText(err, 'Không sửa được'));
  }
}
async function deleteLesson(l: Lesson) {
  if (!window.confirm('Xoá bài học này?')) return;
  try {
    await api.delete(`/ai/auto-reply/lessons/${l.id}`);
    lessons.value = lessons.value.filter((x) => x.id !== l.id);
  } catch (err) {
    toast.error(errorText(err, 'Không xoá được'));
  }
}
async function rateGood(l: LogRow) {
  const next = l.feedback === 'good' ? null : 'good';
  try {
    await api.post(`/ai/auto-reply/logs/${l.id}/feedback`, { rating: next });
    l.feedback = next;
    l.correctedReply = null;
  } catch (err) {
    toast.error(errorText(err, 'Không chấm được'));
  }
}
function openBad(l: LogRow) {
  badLog.value = l;
  badForm.correctedReply = l.correctedReply || '';
  badForm.note = l.feedbackNote || '';
  badDialog.value = true;
}
async function submitBad() {
  if (!badLog.value) return;
  sendingFeedback.value = true;
  try {
    const { data } = await api.post(`/ai/auto-reply/logs/${badLog.value.id}/feedback`, {
      rating: 'bad', correctedReply: badForm.correctedReply, note: badForm.note,
    });
    badLog.value.feedback = 'bad';
    badLog.value.correctedReply = badForm.correctedReply || null;
    badLog.value.feedbackNote = badForm.note || null;
    badDialog.value = false;
    if (data.lesson) toast.success(`AI đã rút bài học: ${data.lesson}`, 6000);
    else toast.warning(`Đã ghi phản hồi. ${data.reason ? 'Chưa rút được bài học: ' + data.reason : ''}`);
    await loadProfiles();
  } catch (err) {
    toast.error(errorText(err, 'Không gửi được phản hồi'));
  } finally {
    sendingFeedback.value = false;
  }
}
const GUIDE_MAX = 30000;
const refFileInput = ref<HTMLInputElement | null>(null);
const readingSkill = ref(false);
const viewRef = ref<GuideFile | null>(null);
const refChars = computed(() => form.guideFiles.reduce((s, f) => s + f.content.length, 0));
const guideFileInput = ref<HTMLInputElement | null>(null);

const GUIDE_TEMPLATE = `# Vai trò
Bạn là … (tên), nhân viên tư vấn của … (tên shop / kho sỉ).

# Xưng hô & giọng văn
- Xưng "em", gọi khách là "anh/chị" (hoặc: xưng "chị", gọi khách "em").
- Giọng thân thiện, ngắn gọn, dùng "dạ", "ạ".

# Sản phẩm & giá
- (ghi sản phẩm chính, giá sỉ/lẻ, số lượng tối thiểu…)

# Ship & thanh toán
- (phí ship, thời gian giao, hình thức thanh toán…)

# Cách tư vấn
- Hỏi khách cần mặt hàng nào, số lượng bao nhiêu trước khi báo giá.
- Khách hỏi giá sỉ số lượng lớn thì xin SĐT để nhân viên gọi lại.

# Điều không được làm
- Không hứa giao hàng ngay trong ngày nếu chưa kiểm tra.
`;

function insertGuideTemplate() {
  if (form.extraInstruction?.trim() && !window.confirm('Ô hướng dẫn đang có nội dung. Chèn mẫu vào cuối?')) return;
  form.extraInstruction = form.extraInstruction?.trim() ? `${form.extraInstruction.trim()}\n\n${GUIDE_TEMPLATE}` : GUIDE_TEMPLATE;
}

async function onGuideFile(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ''; // chọn lại cùng file vẫn kích hoạt
  if (!file) return;
  if (file.size > 5_000_000) {
    toast.error('File quá lớn (tối đa 5 MB).');
    return;
  }
  readingSkill.value = true;
  try {
    const skill = await readSkillFile(file);
    const isPack = /\.(skill|zip)$/i.test(file.name);
    if (!skill.main && !skill.references.length) {
      toast.warning('File trống.');
      return;
    }
    const hasData = !!form.extraInstruction?.trim() || form.guideFiles.length > 0;
    const what = isPack ? 'hướng dẫn và toàn bộ tài liệu tham khảo' : 'hướng dẫn chính';
    if (hasData && !window.confirm(`Thay ${what} hiện tại bằng "${file.name}"?`)) return;
    let main = skill.main;
    if (main.length > GUIDE_MAX) {
      toast.warning(`Hướng dẫn chính dài ${main.length.toLocaleString('vi-VN')} ký tự, chỉ giữ ${GUIDE_MAX.toLocaleString('vi-VN')} ký tự đầu.`);
      main = main.slice(0, GUIDE_MAX);
    }
    form.extraInstruction = main;
    form.guideFileName = file.name;
    if (isPack) {
      form.guideFiles = skill.references.map((d) => ({ path: d.path, content: d.content, mode: defaultReferenceMode(d.path) }));
    }
    toast.success(isPack
      ? `Đã nạp skill "${skill.name}": hướng dẫn chính + ${skill.references.length} tài liệu tham khảo. Kiểm tra chế độ từng tài liệu rồi bấm Lưu cấu hình.`
      : `Đã nạp "${file.name}". Nhớ bấm Lưu cấu hình.`, 6000);
  } catch (err) {
    toast.error(`Không đọc được file: ${(err as Error).message}`);
  } finally {
    readingSkill.value = false;
  }
}

async function onReferenceFiles(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = '';
  for (const file of files) {
    const content = (await file.text()).replace(/\r\n/g, '\n').trim();
    if (!content) continue;
    const idx = form.guideFiles.findIndex((f) => f.path === file.name);
    const entry = { path: file.name, content, mode: defaultReferenceMode(file.name) };
    if (idx >= 0) form.guideFiles.splice(idx, 1, entry);
    else form.guideFiles.push(entry);
  }
  if (files.length) toast.success(`Đã thêm ${files.length} tài liệu. Nhớ bấm Lưu cấu hình.`);
}

function guideSummary(p: Profile) {
  if (p.guideFileName) return `Skill: ${p.guideFileName}${p.guideFiles?.length ? ` · ${p.guideFiles.length} tài liệu` : ''}`;
  const text = (p.extraInstruction || p.persona || '').replace(/^#+\s*/gm, '').trim();
  if (!text) return 'chưa có (mặc định xưng em / anh chị)';
  return text.split('\n').find((l) => l.trim())?.trim() || text;
}
const nickEntries = computed(() => playbook.value.filter((e) => e.zaloAccountId === editingAccountId.value));
const selectedCount = computed(() =>
  [...zaloTags.value, ...crmTags.value].filter((o) => form.triggerTags.includes(o.value)).reduce((s, o) => s + o.count, 0));

// ── Mục kịch bản ──
const entryDialog = ref(false);
const savingEntry = ref(false);
const entryError = ref('');
const editingEntry = ref<PlaybookEntry | null>(null);
const entryForm = reactive({
  zaloAccountId: null as string | null, title: '', category: '', keywords: [] as string[], content: '', priority: 0, enabled: true,
});

// ── Chạy thử ──
const testInput = ref('');
const testing = ref(false);
const testResult = ref<{ decision: string; reason: string; content?: string } | null>(null);

function errorText(err: unknown, fallback: string) {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback;
}
function cleanTag(t: string) { return t.replace(/^🔵\s*/, ''); }
function accountName(id: string | null) {
  return accounts.value.find((a) => a.id === id)?.name || '';
}
function statusLabel(p: Profile) {
  if (!p.enabled) return 'Đang tắt';
  return p.mode === 'auto' ? 'Tự gửi' : 'Chạy thử';
}
function statusColor(p: Profile) {
  if (!p.enabled) return 'grey';
  return p.mode === 'auto' ? 'success' : 'info';
}
function decisionLabel(d: string) {
  return ({ sent: 'Đã gửi', dry_run: 'Chạy thử', handoff: 'Chuyển người', skipped: 'Bỏ qua', error: 'Lỗi' } as Record<string, string>)[d] || d;
}
function decisionColor(d: string) {
  return ({ sent: 'success', dry_run: 'info', handoff: 'warning', skipped: 'grey', error: 'error' } as Record<string, string>)[d] || 'grey';
}
function fmtTime(iso: string) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ${d.getDate()}/${d.getMonth() + 1}`;
}

async function loadProfiles() {
  const { data } = await api.get('/ai/auto-reply/profiles');
  profiles.value = data.profiles;
  accounts.value = data.accounts;
  if (data.server) server.value = data.server;
}
async function loadPlaybook() {
  playbook.value = (await api.get('/ai/auto-reply/playbook')).data.entries;
}
async function loadLogs() {
  try {
    const { data } = await api.get('/ai/auto-reply/logs', { params: { limit: 50, ...(logAccount.value ? { accountId: logAccount.value } : {}) } });
    logs.value = data.logs;
  } catch { /* nhật ký lỗi không chặn trang */ }
}

async function loadAll() {
  try {
    await Promise.all([loadProfiles(), loadPlaybook()]);
    loadError.value = '';
  } catch (err) {
    loadError.value = errorText(err, 'Không tải được cài đặt AI tự trả lời');
  }
  await loadLogs();
}

async function loadTagsFor(accountId: string) {
  loadingTags.value = true;
  try {
    const res = await api.get('/ai/auto-reply/tags', { params: { accountIds: accountId } });
    zaloTags.value = res.data.zalo[0]?.labels ?? [];
    crmTags.value = res.data.crm ?? [];
  } finally {
    loadingTags.value = false;
  }
}

async function loadEditor(accountId: string) {
  const [{ data }] = await Promise.all([api.get(`/ai/auto-reply/profiles/${accountId}`), loadTagsFor(accountId)]);
  const p = data.profile as Profile;
  // Gộp "vai trò & xưng hô" cũ (nếu còn) vào hướng dẫn.
  const guide = [p.persona?.trim() ? `Vai trò & xưng hô: ${p.persona.trim()}` : '', p.extraInstruction?.trim() || '']
    .filter(Boolean).join('\n\n');
  Object.assign(form, p, {
    persona: null, extraInstruction: guide, guideFileName: p.guideFileName ?? null,
    guideFiles: (p.guideFiles ?? []).map((f) => ({ ...f })),
  });
  editingConfigured.value = !!data.configured;
  if (data.configured) void loadLearning(accountId).catch(() => {});
  else { lessons.value = []; quality.value = []; }
  // Thẻ đã lưu mà nick không còn (vd thẻ Zalo bị xoá) vẫn hiện để bỏ chọn được.
  const available = new Set([...zaloTags.value, ...crmTags.value].map((o) => o.value));
  const missing = form.triggerTags.filter((t) => !available.has(t));
  if (missing.length) crmTags.value = [...crmTags.value, ...missing.map((t) => ({ value: t, text: `${cleanTag(t)} (không còn)`, color: 'grey', count: 0 }))];
}

async function openProfile(accountId: string) {
  editingAccountId.value = accountId;
  editingConfigured.value = true;
  newAccountId.value = null;
  editorOpen.value = true;
  try {
    await loadEditor(accountId);
  } catch (err) {
    toast.error(errorText(err, 'Không tải được cấu hình nick'));
  }
}
function openNew() {
  editingAccountId.value = null;
  newAccountId.value = null;
  editingConfigured.value = false;
  editorOpen.value = true;
}
async function selectNewAccount(id: string | null) {
  if (!id) return;
  editingAccountId.value = id;
  try {
    await loadEditor(id);
    editingConfigured.value = false; // nick mới — vẫn cho đổi nick trước khi lưu
  } catch (err) {
    toast.error(errorText(err, 'Không tải được thẻ của nick'));
  }
}

async function saveProfile() {
  if (!editingAccountId.value) return;
  if (form.enabled && form.triggerTags.length === 0) {
    toast.warning('Chưa chọn thẻ kích hoạt nào: AI sẽ không trả lời ai cả.');
  }
  saving.value = true;
  try {
    await api.put(`/ai/auto-reply/profiles/${editingAccountId.value}`, { ...form });
    toast.success(`Đã lưu cấu hình AI cho nick ${accountName(editingAccountId.value)}`);
    editorOpen.value = false;
    await loadProfiles();
  } catch (err) {
    toast.error(errorText(err, 'Không lưu được cấu hình'));
  } finally {
    saving.value = false;
  }
}
async function removeProfile() {
  const id = editingAccountId.value;
  if (!id || !window.confirm(`Xoá cấu hình AI của nick "${accountName(id)}"? AI sẽ ngừng trả lời khách của nick này.`)) return;
  try {
    await api.delete(`/ai/auto-reply/profiles/${id}`);
    editorOpen.value = false;
    await loadProfiles();
    toast.success('Đã xoá cấu hình');
  } catch (err) {
    toast.error(errorText(err, 'Không xoá được'));
  }
}

function openEntry(entry: PlaybookEntry | null, accountId: string | null) {
  editingEntry.value = entry;
  Object.assign(entryForm, entry
    ? { ...entry, category: entry.category ?? '', keywords: [...(entry.keywords || [])] }
    : { zaloAccountId: accountId, title: '', category: '', keywords: [], content: '', priority: 0, enabled: true });
  entryError.value = '';
  entryDialog.value = true;
}
async function saveEntry() {
  savingEntry.value = true;
  entryError.value = '';
  try {
    const body = { ...entryForm, category: entryForm.category || null };
    if (editingEntry.value?.id) await api.put(`/ai/auto-reply/playbook/${editingEntry.value.id}`, body);
    else await api.post('/ai/auto-reply/playbook', body);
    entryDialog.value = false;
    await loadPlaybook();
  } catch (err) {
    entryError.value = errorText(err, 'Không lưu được mục kịch bản');
  } finally {
    savingEntry.value = false;
  }
}
async function removeEntry(entry: PlaybookEntry) {
  if (!window.confirm(`Xoá mục "${entry.title}"?`)) return;
  try {
    await api.delete(`/ai/auto-reply/playbook/${entry.id}`);
    playbook.value = playbook.value.filter((e) => e.id !== entry.id);
  } catch (err) {
    toast.error(errorText(err, 'Không xoá được'));
  }
}

async function runTest() {
  const m = testInput.value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!m) {
    toast.warning('Không thấy ID hội thoại trong link');
    return;
  }
  testing.value = true;
  testResult.value = null;
  try {
    const { data } = await api.post(`/ai/auto-reply/test/${m[0]}`);
    testResult.value = data;
  } catch (err) {
    toast.error(errorText(err, 'Chạy thử lỗi'));
  } finally {
    testing.value = false;
  }
}

onMounted(loadAll);
</script>

<style scoped>
.aar { max-width: 1100px; }
.aar-title h2 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
.aar-title p { color: rgba(var(--v-theme-on-surface), 0.7); margin-bottom: 16px; line-height: 1.5; }
.aar-section-title { font-weight: 600; margin-bottom: 8px; }
.aar-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
.aar-card {
  text-align: left; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 10px; padding: 14px; background: rgb(var(--v-theme-surface)); cursor: pointer;
  display: flex; flex-direction: column; gap: 6px; transition: box-shadow 0.15s, border-color 0.15s;
}
.aar-card:hover { border-color: rgb(var(--v-theme-primary)); box-shadow: 0 2px 10px rgba(0, 0, 0, 0.08); }
.aar-card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
.aar-avatar {
  width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; flex-shrink: 0;
  background: rgb(var(--v-theme-primary)); color: #fff; font-weight: 600;
}
.aar-card-name { flex: 1; min-width: 0; }
.aar-card-title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.aar-card-sub { font-size: 12px; color: rgba(var(--v-theme-on-surface), 0.6); }
.aar-card-row { font-size: 13px; display: flex; align-items: center; flex-wrap: wrap; gap: 2px; }
.aar-card-label { color: rgba(var(--v-theme-on-surface), 0.6); margin-right: 4px; }
.aar-ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; }
.aar-card-foot { font-size: 12px; color: rgba(var(--v-theme-on-surface), 0.6); margin-top: 4px; }
.aar-card-add {
  border-style: dashed; align-items: center; justify-content: center; min-height: 150px;
  color: rgb(var(--v-theme-primary)); font-weight: 500;
}
.aar-card-add:disabled { color: rgba(var(--v-theme-on-surface), 0.4); cursor: default; }
.aar-add-plus { font-size: 28px; line-height: 1; }
.aar-editor { max-height: 72vh; }
.aar-row { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.aar-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }
.aar-hours { display: flex; align-items: center; gap: 8px; }
.aar-step { font-weight: 600; margin-bottom: 8px; }
.aar-taggroup-title { font-size: 13px; margin-bottom: 4px; }
.aar-count { margin-left: 6px; font-size: 11px; opacity: 0.7; }
.aar-hint { font-size: 13px; color: rgba(var(--v-theme-on-surface), 0.65); margin: 4px 0 8px; }
.aar-reply { white-space: pre-wrap; margin-top: 4px; }
.aar-nowrap { white-space: nowrap; }
.aar-good { color: rgb(var(--v-theme-success)); }
.aar-mid { color: rgb(var(--v-theme-warning)); }
.aar-bad { color: rgb(var(--v-theme-error)); }
.aar-quality { display: flex; gap: 4px; align-items: flex-end; height: 76px; padding: 4px 0; }
.aar-qday { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; }
.aar-qbar-wrap { flex: 1; width: 100%; display: flex; align-items: flex-end; background: rgba(var(--v-theme-on-surface), 0.05); border-radius: 3px; }
.aar-qbar { width: 100%; border-radius: 3px; background: currentColor; }
.aar-qlabel { font-size: 10px; color: rgba(var(--v-theme-on-surface), 0.55); margin-top: 2px; }
.teach-body { display: flex; gap: 16px; height: 68vh; }
.teach-chat { flex: 3; display: flex; flex-direction: column; min-width: 0; }
.teach-messages { flex: 1; overflow-y: auto; padding: 8px; background: rgba(var(--v-theme-on-surface), 0.03); border-radius: 8px; }
.teach-empty { padding: 12px; line-height: 1.6; }
.teach-msg { max-width: 82%; margin: 6px 0; padding: 8px 12px; border-radius: 12px; white-space: pre-wrap; font-size: 14px; }
.teach-who { font-size: 11px; opacity: 0.65; margin-bottom: 2px; }
.teach-owner { margin-left: auto; background: rgba(103, 58, 183, 0.12); }
.teach-teacher { background: rgb(var(--v-theme-surface)); border: 1px solid rgba(103, 58, 183, 0.3); }
.teach-customer { margin-left: auto; background: rgba(var(--v-theme-primary), 0.1); border: 1px dashed rgba(var(--v-theme-primary), 0.4); }
.teach-bot { background: rgba(var(--v-theme-success), 0.1); border: 1px dashed rgba(var(--v-theme-success), 0.5); }
.teach-input { padding-top: 8px; }
.teach-side { flex: 2; overflow-y: auto; border-left: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); padding-left: 16px; }
.teach-op { display: flex; gap: 8px; align-items: flex-start; padding: 6px 0; border-bottom: 1px dashed rgba(var(--v-border-color), var(--v-border-opacity)); font-size: 13px; }
.teach-op-text { flex: 1; }
.teach-op-before { text-decoration: line-through; opacity: 0.55; }
@media (max-width: 800px) { .teach-body { flex-direction: column; height: auto; } .teach-side { border-left: none; padding-left: 0; } }
.aar-ref { display: flex; align-items: center; gap: 6px; padding: 3px 0; font-size: 13px; border-bottom: 1px dashed rgba(var(--v-border-color), var(--v-border-opacity)); }
.aar-ref-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.aar-ref-size { font-size: 11px; color: rgba(var(--v-theme-on-surface), 0.55); white-space: nowrap; }
.aar-ref-mode :deep(.v-btn) { text-transform: none; letter-spacing: 0; }
.aar-lesson { display: flex; align-items: center; padding: 4px 0; border-bottom: 1px dashed rgba(var(--v-border-color), var(--v-border-opacity)); font-size: 13px; }
.aar-lesson-text { flex: 1; }
.aar-lesson-off { opacity: 0.5; }
:deep(.aar-cell-title) { font-weight: 500; }
</style>
