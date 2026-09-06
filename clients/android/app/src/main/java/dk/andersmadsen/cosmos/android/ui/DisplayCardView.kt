package dk.andersmadsen.cosmos.android.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dk.andersmadsen.cosmos.android.CreditPart
import dk.andersmadsen.cosmos.android.DisplayCard
import dk.andersmadsen.cosmos.android.DisplayContent

/**
 * Renders the delivered card verbatim. Credits are inert tokens: text or one
 * HTTPS link each. [onCommitted] fires once the composition holding the
 * complete card, credits included, has been applied.
 */
@Composable
fun DisplayCardView(card: DisplayCard, onCommitted: (DisplayCard) -> Unit, modifier: Modifier = Modifier) {
    CosmosPanel(modifier) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
            when (val content = card.content) {
                is DisplayContent.Text -> CosmosMessage(content.text)
                is DisplayContent.Places -> {
                    Text(content.query, color = CosmosPalette.text, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.height(8.dp))
                    if (content.items.isEmpty()) Text("No matching places found.", color = CosmosPalette.text)
                    for (item in content.items) {
                        Text(item.name, color = CosmosPalette.text, fontWeight = FontWeight.SemiBold)
                        Text(item.address, color = CosmosPalette.text)
                        item.sourceUrl?.let { url ->
                            Text(buildAnnotatedString {
                                withLink(LinkAnnotation.Url(url, TextLinkStyles(SpanStyle(color = CosmosPalette.glow, textDecoration = TextDecoration.Underline)))) {
                                    append("View on Google Maps")
                                }
                            }, fontSize = 14.sp)
                        }
                        Spacer(Modifier.height(6.dp))
                    }
                    Spacer(Modifier.height(4.dp))
                    Text("Google Maps", color = CosmosPalette.secondary, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                    for (credit in content.credits) {
                        Text(buildAnnotatedString {
                            for (part in credit) when (part) {
                                is CreditPart.Text -> append(part.text)
                                is CreditPart.Link -> withLink(LinkAnnotation.Url(part.href,
                                    TextLinkStyles(SpanStyle(color = CosmosPalette.glow, textDecoration = TextDecoration.Underline)))) { append(part.text) }
                            }
                        }, color = CosmosPalette.secondary, fontSize = 12.sp)
                    }
                }
            }
        }
    }
    // The effect runs after this composition, including every credit line, is applied.
    LaunchedEffect(card.actionId) { onCommitted(card) }
}
